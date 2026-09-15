import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * El correo saliente: que deje rastro y que avise cuando está mal parado.
 *
 * El 14-09-2026 un mail de verificación no llegó y los logs de Vercel estaban
 * MUDOS: `sendSystemEmail` devolvía el error prolijamente y los dos que la
 * llaman lo tiraban a la basura. Tampoco había forma de notar que los mails
 * salían desde otra marca (`labelflowsas.com`) que la del sitio
 * (`autoenvia.com`), que es justamente por lo que Gmail los filtra.
 */

import {
  sendSystemEmail,
  diagnosticoDeCorreo,
  dominioDelRemitente,
} from '../email-system';

const ENV = { ...process.env };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ENV };
});

function fetchFalso(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const MAIL = { to: 'carla@vittoriaco.com', subject: 'Confirmá tu email', html: '<p>x</p>', tag: 'verify_email' };

describe('dominioDelRemitente', () => {
  it('lo saca de un "Nombre <mail@dominio>"', () => {
    expect(dominioDelRemitente('AutoEnvía <noreply@autoenvia.com>')).toBe('autoenvia.com');
  });
  it('y de un mail pelado', () => {
    expect(dominioDelRemitente('noreply@labelflowsas.com')).toBe('labelflowsas.com');
  });
  it('sin arroba devuelve null', () => {
    expect(dominioDelRemitente('cualquier cosa')).toBeNull();
  });
});

describe('sendSystemEmail — todo envío deja rastro', () => {
  it('un envío que sale bien se loguea con el id de Resend', async () => {
    process.env.RESEND_API_KEY = 're_falsa';
    vi.stubGlobal('fetch', fetchFalso(200, { id: 'abc-123' }));

    const r = await sendSystemEmail(MAIL);

    expect(r.ok).toBe(true);
    const linea = (console.info as unknown as { mock: { calls: string[][] } }).mock.calls[0].join(' ');
    // El id es lo que permite cruzar un reclamo con resend.com/emails.
    expect(linea).toContain('abc-123');
    expect(linea).toContain('verify_email');
  });

  it('🔴 un rechazo de Resend se loguea como ERROR — antes no quedaba rastro', async () => {
    process.env.RESEND_API_KEY = 're_falsa';
    vi.stubGlobal('fetch', fetchFalso(403, { message: 'Domain not verified' }));

    const r = await sendSystemEmail(MAIL);

    expect(r.ok).toBe(false);
    expect(console.error).toHaveBeenCalled();
    const linea = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0].join(' ');
    expect(linea).toContain('Domain not verified');
    expect(linea).toContain('403');
  });

  it('se loguea el DOMINIO del destinatario, nunca su dirección', async () => {
    process.env.RESEND_API_KEY = 're_falsa';
    vi.stubGlobal('fetch', fetchFalso(500, { message: 'boom' }));

    await sendSystemEmail(MAIL);

    const linea = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0].join(' ');
    // Con el dominio alcanza para ver "todo lo que va a Gmail rebota".
    expect(linea).toContain('vittoriaco.com');
    // La dirección de una persona NO va a los logs.
    expect(linea).not.toContain('carla@');
  });

  it('sin clave avisa como warning, no como error: es lo normal en preview', async () => {
    delete process.env.RESEND_API_KEY;
    const r = await sendSystemEmail(MAIL);
    expect(r.ok).toBe(false);
    expect(console.warn).toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('un fallo de red también queda registrado', async () => {
    process.env.RESEND_API_KEY = 're_falsa';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ETIMEDOUT'); }) as unknown as typeof fetch);

    const r = await sendSystemEmail(MAIL);

    expect(r.ok).toBe(false);
    const linea = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls[0].join(' ');
    expect(linea).toContain('ETIMEDOUT');
  });

  it('nunca lanza: un envío roto no puede tirar abajo el alta', async () => {
    process.env.RESEND_API_KEY = 're_falsa';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('x'); }) as unknown as typeof fetch);
    await expect(sendSystemEmail(MAIL)).resolves.toMatchObject({ ok: false });
  });
});

describe('sendSystemEmail — Reply-To', () => {
  it('con RESEND_REPLY_TO puesto, la respuesta cae donde hay alguien', async () => {
    process.env.RESEND_API_KEY = 're_falsa';
    process.env.RESEND_REPLY_TO = 'hola@autoenvia.com';
    const f = fetchFalso(200, { id: 'x' });
    vi.stubGlobal('fetch', f);

    await sendSystemEmail(MAIL);

    const body = JSON.parse((f as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0][1].body);
    expect(body.reply_to).toBe('hola@autoenvia.com');
  });

  it('sin la variable el payload queda igual que antes', async () => {
    process.env.RESEND_API_KEY = 're_falsa';
    delete process.env.RESEND_REPLY_TO;
    const f = fetchFalso(200, { id: 'x' });
    vi.stubGlobal('fetch', f);

    await sendSystemEmail(MAIL);

    const body = JSON.parse((f as unknown as { mock: { calls: [string, { body: string }][] } }).mock.calls[0][1].body);
    expect(body).not.toHaveProperty('reply_to');
  });
});

describe('diagnosticoDeCorreo — la comprobación que faltaba', () => {
  it('sin clave: no configurado', () => {
    delete process.env.RESEND_API_KEY;
    expect(diagnosticoDeCorreo().status).toBe('not_configured');
  });

  it('🔴 mandar desde otra marca que la del sitio sale como degradado', () => {
    // Exactamente el estado de producción el 14-09-2026.
    process.env.RESEND_API_KEY = 're_falsa';
    process.env.RESEND_FROM = 'AutoEnvía <noreply@labelflowsas.com>';
    process.env.NEXTAUTH_URL = 'https://autoenvia.com';

    const d = diagnosticoDeCorreo();
    expect(d.status).toBe('degraded');
    if (d.status !== 'degraded') return;
    expect(d.reason).toContain('labelflowsas.com');
    expect(d.reason).toContain('autoenvia.com');
  });

  it('con el remitente del mismo dominio que la app: ok', () => {
    process.env.RESEND_API_KEY = 're_falsa';
    process.env.RESEND_FROM = 'AutoEnvía <noreply@autoenvia.com>';
    process.env.NEXTAUTH_URL = 'https://autoenvia.com';
    expect(diagnosticoDeCorreo().status).toBe('ok');
  });

  it('un subdominio propio NO es una marca ajena', () => {
    // Lo que penaliza Gmail es otra marca, no mail.autoenvia.com.
    process.env.RESEND_API_KEY = 're_falsa';
    process.env.RESEND_FROM = 'AutoEnvía <noreply@mail.autoenvia.com>';
    process.env.NEXTAUTH_URL = 'https://autoenvia.com';
    expect(diagnosticoDeCorreo().status).toBe('ok');
  });

  it('www no cuenta como dominio distinto', () => {
    process.env.RESEND_API_KEY = 're_falsa';
    process.env.RESEND_FROM = 'AutoEnvía <noreply@autoenvia.com>';
    process.env.NEXTAUTH_URL = 'https://www.autoenvia.com';
    expect(diagnosticoDeCorreo().status).toBe('ok');
  });

  it('un remitente sin dominio válido se reporta', () => {
    process.env.RESEND_API_KEY = 're_falsa';
    process.env.RESEND_FROM = 'AutoEnvía';
    process.env.NEXTAUTH_URL = 'https://autoenvia.com';
    expect(diagnosticoDeCorreo().status).toBe('degraded');
  });

  it('nunca devuelve la clave', () => {
    process.env.RESEND_API_KEY = 're_secreta_no_mostrar';
    process.env.RESEND_FROM = 'AutoEnvía <noreply@labelflowsas.com>';
    process.env.NEXTAUTH_URL = 'https://autoenvia.com';
    expect(JSON.stringify(diagnosticoDeCorreo())).not.toContain('re_secreta');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Los documentos legales tienen que describir el producto que se vende.
 *
 * Hasta el 2026-09-02, /terminos §2 publicaba planes mensuales —Starter USD
 * 15/mes, Growth USD 35/mes, Pro USD 69/mes, 14 días de prueba— que la
 * plataforma nunca vendió, y §7 prometía cancelar una suscripción y un
 * reembolso prorrateado sobre un "ciclo de facturación" inexistente. La landing
 * de la misma sesión decía, cuatro veces, "pago único, sin suscripción". Eran
 * dos precios contradictorios del mismo producto, y el de los Términos es el
 * documento que el usuario acepta obligatoriamente al crear la cuenta.
 *
 * Además publicaban `soporte@labelflow.uy`: un dominio SIN NS, SIN SOA y SIN MX
 * (NXDOMAIN contra 8.8.8.8 y 1.1.1.1). Era el único canal ofrecido para pedir un
 * reembolso y para ejercer los derechos de la Ley 18.331 — o sea, el reclamo
 * rebotaba y el cliente creía que había reclamado.
 *
 * Este test es de TEXTO a propósito: lo que rompe acá no es el tipo, es la
 * afirmación.
 */
const raiz = join(__dirname, '..', '..', 'app');
const leer = (p: string) => readFileSync(join(raiz, p), 'utf8');

const TERMINOS = leer('terminos/page.tsx');
const PRIVACIDAD = leer('privacidad/page.tsx');
const VERIFY = leer('(auth)/verify-email/page.tsx');

describe('páginas legales: sin productos inventados', () => {
  it('no venden planes mensuales que no existen', () => {
    for (const fantasma of ['USD 15/mes', 'USD 35/mes', 'USD 69/mes', 'Starter', 'Growth']) {
      expect(TERMINOS).not.toContain(fantasma);
    }
  });

  it('no prometen un período de prueba de 14 días', () => {
    expect(TERMINOS).not.toContain('14 días');
    expect(TERMINOS).toContain('{TRIAL_SHIPMENTS} envíos de prueba');
  });

  it('no prometen cancelar una suscripción ni un ciclo de facturación', () => {
    expect(TERMINOS).not.toContain('ciclo de facturación');
    expect(TERMINOS).not.toContain('cancelar su suscripción');
    expect(TERMINOS).toContain('No hay suscripción que cancelar');
  });

  it('los precios del documento salen de la tabla que cobra, no escritos a mano', () => {
    expect(TERMINOS).toContain("from '@/lib/pricing'");
    expect(TERMINOS).toContain('LIST_PRICE_USD');
  });
});

describe('páginas legales: el canal de contacto recibe', () => {
  it('ninguna pantalla publica una casilla en un dominio que no recibe', () => {
    for (const [nombre, src] of Object.entries({ TERMINOS, PRIVACIDAD, VERIFY })) {
      expect(nombre + ':' + src).not.toContain('soporte@labelflow.uy');
      expect(nombre + ':' + src).not.toContain('soporte@autoenvia.com');
    }
  });

  it('el canal publicado es el mismo en los tres lados y sale de una fuente única', () => {
    for (const src of [TERMINOS, PRIVACIDAD, VERIFY]) {
      expect(src).toContain("from '@/lib/contacto'");
      expect(src).toContain('whatsappUrl');
    }
  });

  it('la pantalla de verificación no manda a escribir un mail a quien no recibe mails', () => {
    expect(VERIFY).not.toContain('mailto:');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El código 99 de AHIVA.
 *
 * Verificado en vivo contra ahivatest el 04-09-2026: el servidor devuelve
 * `codigoRespuesta=99` con `esError=true` y la descripción textual
 * «Error interno : reintente el pedido». Es su catch-all interno, y viaja por
 * el MISMO campo `esError` que un rechazo de validación.
 *
 * Tratarlo como rechazo probado —que es lo que hacía derivar el flag de
 * `esError` a secas— borra el marcador de idempotencia y la corrida siguiente
 * emite una segunda guía con un segundo cobro. El servidor está pidiendo
 * reintentar, no diciendo que rechazó.
 */
const post = vi.fn();
vi.mock('axios', () => ({
  default: { post: (...a: unknown[]) => post(...a) },
  AxiosError: class extends Error {},
}));

const respuesta = (codigo: number, desc: string) =>
  `<?xml version="1.0"?><S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>` +
  `<ns2:cargaMasivaResponse xmlns:ns2="http://webservices/"><return>` +
  `<codigoRespuesta>${codigo}</codigoRespuesta><descripcionRespuesta>${desc}</descripcionRespuesta>` +
  `<esError>true</esError></return></ns2:cargaMasivaResponse></S:Body></S:Envelope>`;

const envio = {
  soloDestinatario: false,
  destinatario: { nombre: 'X', mail: 'a@b.com', celular: '099123456' },
  lugarEntrega: { oficinaCorreo: 'Salto' },
  paquetesSimples: [{ peso: 1 }],
} as never;

beforeEach(() => vi.clearAllMocks());

describe('clasificación de los errores de AHIVA', () => {
  it('el 99 es reintentable y NO prueba que el envío no se creó', async () => {
    const { cargaMasiva } = await import('../correo/client');
    const { CorreoError } = await import('../correo/types');
    post.mockResolvedValue({ status: 200, data: respuesta(99, 'Error interno : reintente el pedido') });

    await expect(
      cargaMasiva({ ambiente: 'test', credenciales: { user: 'u', password: 'p' }, envios: [envio] }),
    ).rejects.toSatisfy((e: unknown) => {
      const err = e as InstanceType<typeof CorreoError>;
      return err.codigo === 99 && err.retryable === true && err.esRechazoDeNegocio === false;
    });
  });

  it('un rechazo de validación sí prueba que no se creó nada', async () => {
    const { cargaMasiva } = await import('../correo/client');
    const { CorreoError } = await import('../correo/types');
    post.mockResolvedValue({ status: 200, data: respuesta(2, 'usuario y/o password vacios') });

    await expect(
      cargaMasiva({ ambiente: 'test', credenciales: { user: '', password: '' }, envios: [envio] }),
    ).rejects.toSatisfy((e: unknown) => {
      const err = e as InstanceType<typeof CorreoError>;
      return err.codigo === 2 && err.retryable === false && err.esRechazoDeNegocio === true;
    });
  });
});

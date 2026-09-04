/**
 * Verificador manual del carrier Correo Uruguayo. NO forma parte del worker:
 * no lo importa nadie, se corre a mano.
 *
 *   npx ts-node src/correo/probe.ts
 *
 * Sin credenciales hace lo que se puede sin cuenta:
 *   1. lista las oficinas de correo (el servicio no pide auth)
 *   2. imprime el envelope que mandaríamos, para inspección
 *   3. golpea el ambiente de TEST con credenciales vacías — si responde
 *      "usuario incorrecto" en vez de un error de parseo, el envelope es
 *      sintácticamente válido para el servidor
 *
 * Con credenciales de TEST (variables de entorno) emite una etiqueta real
 * contra ahivatest y guarda el PDF en /tmp:
 *   CORREO_USER=... CORREO_PASSWORD=... [CORREO_CUENTA=... CORREO_SUBCUENTA=...]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  cargaMasiva,
  construirCargaMasivaEnvelope,
  obtenerLocalidadesCorreo,
} from './client';
import { CorreoError, type DataEnvio } from './types';
import { normalizarCelular, normalizarDepartamento, resolverPesoKg, validarDestinatario } from './mapper';

const envioDemo: DataEnvio = {
  soloDestinatario: false,
  destinatario: {
    nombre: 'Prueba AutoEnvia',
    mail: 'prueba@autoenvia.com',
    celular: '099123456',
  },
  lugarEntrega: {
    departamento: 'MONTEVIDEO',
    localidad: 'Pocitos',
    calle: 'Juan Benito Blanco',
    nroPuerta: '992',
    observacionesDireccion: 'Prueba de integracion — no despachar',
  },
  paquetesSimples: [
    { peso: 1, responsableServEntrega: 'REMITENTE', referencia: 'PRUEBA INTEGRACION' },
  ],
};

async function main(): Promise<void> {
  console.log('=== 1. Normalizadores (puro, sin red) ===');
  console.log('  Paysandú        →', normalizarDepartamento('Paysandú'));
  console.log('  +598 99 123 456 →', normalizarCelular('+598 99 123 456'));
  console.log('  1500 g          →', JSON.stringify(resolverPesoKg(1500, null)));
  console.log('  destinatario    →', JSON.stringify(validarDestinatario(envioDemo.destinatario)));

  console.log('\n=== 2. obtenerLocalidadesCorreo (PROD, sin credenciales) ===');
  try {
    const locs = await obtenerLocalidadesCorreo('prod');
    console.log(`  OK — ${locs.length} oficinas`);
    for (const l of locs.slice(0, 3)) {
      console.log(`    ${l.nombre} (${l.departamento}) · CP ${l.codigoPostal} · AHIVA ${l.codigoAHIVA}`);
    }
    const porDepto = locs.reduce<Record<string, number>>((acc, l) => {
      acc[l.departamento] = (acc[l.departamento] ?? 0) + 1;
      return acc;
    }, {});
    console.log('  oficinas por departamento:', JSON.stringify(porDepto));
  } catch (err) {
    console.log('  FALLO:', (err as Error).message);
  }

  console.log('\n=== 3. Envelope generado (inspección visual) ===');
  const envelope = construirCargaMasivaEnvelope(
    { user: 'USUARIO', password: 'CLAVE' },
    [],
    [envioDemo],
  );
  console.log(envelope.replace('<arg1>CLAVE</arg1>', '<arg1>***</arg1>'));

  const user = process.env.CORREO_USER;
  const password = process.env.CORREO_PASSWORD;

  console.log('\n=== 4. cargaMasiva contra TEST ===');
  if (!user || !password) {
    console.log('  Sin CORREO_USER/CORREO_PASSWORD — probando el shape con credenciales vacías.');
    console.log('  Un "usuario incorrecto" acá significa que el envelope es válido para el servidor.');
    try {
      await cargaMasiva({
        ambiente: 'test',
        credenciales: { user: '', password: '' },
        envios: [envioDemo],
        timeoutMs: 45_000,
      });
      console.log('  (!) Respondió OK con credenciales vacías — inesperado.');
    } catch (err) {
      const e = err as CorreoError;
      console.log(`  Respuesta del servidor: ${e.message}`);
      console.log(`  retryable=${e.retryable} codigo=${e.codigo}`);
    }
    return;
  }

  const res = await cargaMasiva({
    ambiente: 'test',
    credenciales: {
      user,
      password,
      cuenta: process.env.CORREO_CUENTA,
      subcuenta: process.env.CORREO_SUBCUENTA,
    },
    envios: [envioDemo],
  });

  console.log(`  código=${res.codigoRespuesta} desc="${res.descripcionRespuesta}"`);
  for (const [i, e] of res.envios.entries()) {
    console.log(`  envío ${i}: guías=${e.codigostrazabilidad.join(', ')}`);
    if (e.costos) {
      console.log(`    costos: remitente=${e.costos.costoTotalRemitente} destinatario=${e.costos.costoTotalDestinatario}`);
    }
    if (e.etiquetasBase64) {
      const out = path.join(os.tmpdir(), `correo-etiqueta-${i}.pdf`);
      fs.writeFileSync(out, Buffer.from(e.etiquetasBase64, 'base64'));
      console.log(`    etiqueta PDF → ${out}`);
    }
  }
}

main().catch((err) => {
  console.error('probe falló:', err);
  process.exitCode = 1;
});

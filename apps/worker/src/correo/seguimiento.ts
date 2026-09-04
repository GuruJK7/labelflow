/**
 * Estado de los envíos ya despachados por Correo Uruguayo.
 *
 *   npx ts-node --transpile-only src/correo/seguimiento.ts [--out <dir>] [--codigo <cod>]
 *
 * Lee los `.ok.json` que dejó `cargar.ts` y consulta el estado real de cada
 * código contra el endpoint público (sin credenciales, gratis).
 *
 * Además hace algo que `cargar.ts` no puede: **listar los marcadores
 * pendientes**. Un `.pendiente.json` significa que la llamada a AHIVA se cortó
 * sin saber si el envío se creó. Como Correo no permite consultar por
 * referencia, la reconciliación es a mano — pero esto al menos los junta en un
 * lugar en vez de dejarlos desperdigados.
 */

import fs from 'fs';
import path from 'path';
import { consultarSeguimiento, esCodigoTrazabilidadValido, urlSeguimientoComprador } from './tracking';

interface Despachado {
  referencia: string;
  codigos: string[];
  despachado?: string;
}

function leerDespachados(dir: string): Despachado[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ok.json'))
    .map((f) => {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
      return {
        referencia: typeof j.referencia === 'string' ? j.referencia : f.replace('.ok.json', ''),
        codigos: Array.isArray(j.codigosTrazabilidad) ? (j.codigosTrazabilidad as string[]) : [],
        despachado: typeof j.despachado === 'string' ? j.despachado : undefined,
      };
    });
}

function leerPendientes(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.pendiente.json'));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };

  const codigoSuelto = get('--codigo');
  const dir = get('--out') ?? path.resolve(process.cwd(), 'correo-envios');

  if (codigoSuelto) {
    if (!esCodigoTrazabilidadValido(codigoSuelto)) {
      console.log(
        `⚠  "${codigoSuelto}" no tiene forma de código de Correo (2 letras + 9 dígitos + país).\n` +
          '   Se consulta igual, pero si es una guía DAC no va a existir acá.',
      );
    }
    const s = await consultarSeguimiento(codigoSuelto);
    console.log(`${s.codigo}: ${s.estado} · ${s.codigoEtapaEntrega} · ${s.eventos.length} eventos`);
    console.log(`  para el comprador: ${urlSeguimientoComprador(s.codigo)}`);
    if (s.eventos.length) console.log(JSON.stringify(s.eventos, null, 2));
    return;
  }

  console.log(`=== Seguimiento de envíos de Correo ===\n  carpeta: ${dir}\n`);

  const pendientes = leerPendientes(dir);
  if (pendientes.length) {
    console.log('🔴 MARCADORES PENDIENTES — puede haber envíos creados sin registrar:');
    for (const p of pendientes) console.log(`   ${p}`);
    console.log(
      '   Correo no permite consultar por referencia. Verificá a mano en "Mis envíos"\n' +
        '   del portal antes de reintentar esos pedidos.\n',
    );
  }

  const despachados = leerDespachados(dir);
  if (despachados.length === 0) {
    console.log('No hay envíos despachados registrados todavía.');
    return;
  }

  let entregados = 0;
  let sinEventos = 0;

  for (const d of despachados) {
    if (d.codigos.length === 0) {
      console.log(`  ⚠  ${d.referencia}: despachado sin código de trazabilidad. Revisar en el portal.`);
      continue;
    }
    for (const codigo of d.codigos) {
      try {
        const s = await consultarSeguimiento(codigo);
        const icono = !s.encontrado ? '⏳' : s.eventos.length ? '📦' : '⏳';
        if (!s.encontrado || s.eventos.length === 0) sinEventos += 1;
        if (/ENTREGA/i.test(s.codigoEtapaEntrega) || /ENTREGADO/i.test(s.estado)) entregados += 1;
        console.log(
          `  ${icono} ${d.referencia} · ${codigo} → ${s.estado} / ${s.codigoEtapaEntrega} · ${s.eventos.length} eventos`,
        );
      } catch (err) {
        console.log(`  ❌ ${d.referencia} · ${codigo}: ${(err as Error).message}`);
      }
    }
  }

  console.log(
    `\n── Resumen ──\n  envíos registrados : ${despachados.length}\n` +
      `  con etapa de entrega: ${entregados}\n  sin eventos aún    : ${sinEventos}`,
  );
  if (pendientes.length) {
    console.log(`  🔴 pendientes sin resolver: ${pendientes.length}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('seguimiento.ts falló:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

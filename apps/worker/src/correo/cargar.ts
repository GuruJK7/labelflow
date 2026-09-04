/**
 * Cargador de envíos de Correo Uruguayo (AHIVA). Herramienta de línea de
 * comandos, NO parte del worker: nadie la importa, no se encola, no toca el
 * pipeline de DAC. Se corre a mano.
 *
 *   npx ts-node --transpile-only src/correo/cargar.ts --pedidos pedidos.json
 *
 * Por defecto es DRY-RUN: valida todo, arma el envelope exacto, estima el
 * costo y NO manda nada. Para despachar de verdad hay que pedirlo explícito.
 *
 * Credenciales: SÓLO por variables de entorno, nunca por argumento (los
 * argumentos quedan en el historial del shell y en `ps`).
 *
 *   export CORREO_USER=...
 *   export CORREO_PASSWORD=...
 *   export CORREO_CUENTA=...      # sólo cuentas crédito
 *   export CORREO_SUBCUENTA=...   # sólo cuentas crédito
 *
 * Idempotencia: Correo NO tiene consulta de envíos por referencia (verificado
 * contra los WSDL de ConsultarEstadosService e ImpresionServicev2). Si el
 * proceso muere entre "AHIVA creó el envío" y "guardamos el resultado", no hay
 * forma de preguntarle al correo si existe. Por eso el marcador se escribe en
 * disco ANTES de la llamada, y un marcador pendiente BLOQUEA el reintento.
 */

import fs from 'fs';
import path from 'path';
import { cargaMasiva, construirCargaMasivaEnvelope, obtenerLocalidadesCorreo, type CorreoAmbiente } from './client';
import { construirEnvio, estimarTarifaUYU, type PedidoParaCorreo } from './validate';
import { estimarCargoCodUYU } from './cod';
import { CorreoError, type DataEnvio, type LocalidadCorreo } from './types';

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------

interface Opciones {
  pedidos: string;
  ambiente: CorreoAmbiente;
  enviar: boolean;
  confirmoProduccion: boolean;
  out: string;
  sinCatalogo: boolean;
  solo: string | null;
}

function parsearArgs(argv: string[]): Opciones {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const ambienteRaw = get('--ambiente') ?? 'test';
  if (ambienteRaw !== 'test' && ambienteRaw !== 'prod') {
    throw new Error(`--ambiente tiene que ser "test" o "prod" (recibido: "${ambienteRaw}")`);
  }

  const pedidos = get('--pedidos');
  if (!pedidos) throw new Error('Falta --pedidos <archivo.json>');

  return {
    pedidos,
    ambiente: ambienteRaw,
    enviar: has('--enviar'),
    confirmoProduccion: has('--confirmo-produccion'),
    // Anclado al paquete, no al cwd: los marcadores son el ÚNICO freno contra
    // el doble despacho (Correo no tiene consulta por referencia), y con
    // `process.cwd()` correr el CLI desde otra carpeta los hacía invisibles y
    // re-despachaba todo.
    out: get('--out') ?? path.resolve(__dirname, '..', '..', 'correo-envios'),
    sinCatalogo: has('--sin-catalogo'),
    solo: get('--solo'),
  };
}

// ---------------------------------------------------------------------------
// Idempotencia en disco
// ---------------------------------------------------------------------------

/**
 * Nombre de archivo seguro a partir de una referencia arbitraria.
 *
 * 🔴 El `.trim()` NO es cosmético. El chequeo del marcador usa la referencia
 * trimeada (`estadoDe`, más abajo) y la escritura usaba la CRUDA: una referencia
 * con espacios al borde ("AE-1 ") se chequeaba como `AE-1` y se escribía como
 * `AE-1_`, así que el marcador nunca se encontraba y la corrida siguiente
 * despachaba el pedido OTRA VEZ — segunda guía y segundo cobro. Normalizando
 * acá, las dos puntas quedan atadas por construcción.
 */
function slug(referencia: string): string {
  return referencia.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

type EstadoMarcador = 'libre' | 'pendiente' | 'hecho';

function estadoDe(dir: string, referencia: string): EstadoMarcador {
  const base = path.join(dir, slug(referencia));
  if (fs.existsSync(`${base}.ok.json`)) return 'hecho';
  if (fs.existsSync(`${base}.pendiente.json`)) return 'pendiente';
  return 'libre';
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

function redactar(envelope: string): string {
  return envelope.replace(/<arg1>[\s\S]*?<\/arg1>/, '<arg1>***REDACTADO***</arg1>');
}

function leerPedidos(file: string): PedidoParaCorreo[] {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`No existe el archivo de pedidos: ${abs}`);
  const parsed: unknown = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr as PedidoParaCorreo[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Preparado {
  pedido: PedidoParaCorreo;
  envio: DataEnvio;
  avisos: string[];
}

async function main(): Promise<void> {
  const opts = parsearArgs(process.argv.slice(2));

  console.log('=== Cargador Correo Uruguayo (AHIVA) ===');
  console.log(`  ambiente : ${opts.ambiente.toUpperCase()}`);
  console.log(`  modo     : ${opts.enviar ? 'ENVIAR (crea envíos reales)' : 'DRY-RUN (no manda nada)'}`);
  console.log(`  pedidos  : ${path.resolve(opts.pedidos)}`);
  console.log(`  salida   : ${opts.out}`);

  // --- Guardas de producción -----------------------------------------------
  if (opts.enviar && opts.ambiente === 'prod' && !opts.confirmoProduccion) {
    console.error(
      '\n🔴 ABORTADO: --enviar contra PRODUCCIÓN exige además --confirmo-produccion.\n' +
        '   Cada envío emitido es real, facturable y no se puede deshacer.',
    );
    process.exitCode = 1;
    return;
  }

  const usuario = process.env.CORREO_USER;
  const password = process.env.CORREO_PASSWORD;
  if (opts.enviar && (!usuario || !password)) {
    console.error(
      '\n🔴 ABORTADO: faltan CORREO_USER y/o CORREO_PASSWORD en el entorno.\n' +
        '   Las credenciales no se pasan por argumento a propósito.',
    );
    process.exitCode = 1;
    return;
  }

  const pedidos = leerPedidos(opts.pedidos).filter(
    (p) => !opts.solo || p.referencia === opts.solo,
  );
  if (pedidos.length === 0) {
    console.error('\n🔴 No hay pedidos para procesar.');
    process.exitCode = 1;
    return;
  }
  console.log(`  a procesar: ${pedidos.length}\n`);

  // --- Catálogo de oficinas (gratis, sin credenciales) ----------------------
  let catalogo: LocalidadCorreo[] = [];
  // La oficina de DEVOLUCIÓN se valida contra el mismo catálogo que la de
  // entrega. Mirar sólo `oficinaCorreo` dejaba sin catálogo a un envío a
  // domicilio que igual pide devolución en sucursal, y el pre-vuelo lo
  // rechazaba con "no se pasó el catálogo" — un rechazo que no era del pedido.
  const necesitaCatalogo = pedidos.some(
    (p) => (p.oficinaCorreo ?? '').trim() || (p.oficinaDevolucion ?? '').trim(),
  );
  if (necesitaCatalogo && !opts.sinCatalogo) {
    process.stdout.write('Bajando catálogo de oficinas... ');
    catalogo = await obtenerLocalidadesCorreo(opts.ambiente);
    console.log(`${catalogo.length} oficinas.`);
  }

  // --- Validación de todos, antes de mandar uno solo -----------------------
  const listos: Preparado[] = [];
  const rechazados: Array<{ referencia: string; motivos: string[] }> = [];
  const bloqueados: Array<{ referencia: string; estado: EstadoMarcador }> = [];

  for (const pedido of pedidos) {
    const ref = (pedido.referencia ?? '(sin referencia)').trim();

    const estado = fs.existsSync(opts.out) ? estadoDe(opts.out, ref) : 'libre';
    if (estado !== 'libre') {
      bloqueados.push({ referencia: ref, estado });
      continue;
    }

    const r = construirEnvio(pedido, catalogo);
    if (r.ok) listos.push({ pedido, envio: r.envio, avisos: r.avisos });
    else rechazados.push({ referencia: ref, motivos: r.motivos });
  }

  // --- Informe --------------------------------------------------------------
  if (bloqueados.length) {
    console.log('── Bloqueados por marcador previo ──');
    for (const b of bloqueados) {
      if (b.estado === 'hecho') {
        console.log(`  ⏭  ${b.referencia}: ya fue despachado (existe .ok.json). Se saltea.`);
      } else {
        console.log(
          `  🔴 ${b.referencia}: quedó un marcador PENDIENTE de una corrida anterior.\n` +
            '      Puede haber un envío creado en Correo sin registrar. Correo no permite\n' +
            '      consultar por referencia: verificá a mano en "Mis envíos" del portal antes\n' +
            '      de borrar el marcador. NO se reintenta solo.',
        );
      }
    }
    console.log('');
  }

  if (rechazados.length) {
    console.log('── Rechazados en pre-vuelo (no se llama a AHIVA) ──');
    for (const r of rechazados) {
      console.log(`  ❌ ${r.referencia}`);
      for (const m of r.motivos) console.log(`       · ${m}`);
    }
    console.log('');
  }

  if (listos.length === 0) {
    console.log('No queda ningún envío para despachar.');
    return;
  }

  console.log('── Listos para despachar ──');
  let estimadoTotal = 0;
  for (const l of listos) {
    // El paquete puede estar en cualquiera de las dos listas: con mercadería a
    // cobrar vive dentro de contraReembolsos[].paquetes. Leer sólo
    // paquetesSimples daba peso 0 y tarifa "?" justo en los envíos con cobro,
    // o sea que el estimado total de una carga contrareembolso era $0.
    const paquetes = [
      ...(l.envio.paquetesSimples ?? []),
      ...(l.envio.contraReembolsos ?? []).flatMap((cr) => cr.paquetes),
    ];
    const peso = paquetes.reduce((acc, p) => acc + (p.peso ?? 0), 0);
    const tarifa = estimarTarifaUYU(peso);
    if (tarifa) estimadoTotal += tarifa;

    const cobro = l.envio.contraReembolsos?.[0];
    const cargoCod = cobro ? estimarCargoCodUYU(cobro.monto) : null;
    if (cargoCod) estimadoTotal += cargoCod;

    const destino = l.envio.lugarEntrega.oficinaCorreo
      ? `sucursal ${l.envio.lugarEntrega.oficinaCorreo}`
      : `${l.envio.lugarEntrega.localidad}, ${l.envio.lugarEntrega.departamento}`;
    console.log(
      `  ✅ ${l.pedido.referencia} → ${l.envio.destinatario.nombre} · ${destino} · ` +
        `${peso} kg · ~$${tarifa ?? '?'}` +
        (cobro ? `  ·  cobra en destino $${cobro.monto} (+~$${cargoCod ?? '?'} de servicio)` : '') +
        (l.envio.datosdevolucion?.oficinaCorreo ? `  ·  devuelve a ${l.envio.datosdevolucion.oficinaCorreo}` : ''),
    );
    for (const a of l.avisos) console.log(`       ⚠  ${a}`);
  }
  console.log(
    `\n  Estimado total: ~$${estimadoTotal} UYU  (tarifario 01/11/2025 — dato volátil,\n` +
      '  el número que vale es el campo "costos" que devuelve AHIVA)\n',
  );

  // --- DRY-RUN --------------------------------------------------------------
  if (!opts.enviar) {
    const envelope = construirCargaMasivaEnvelope(
      { user: usuario ?? 'USUARIO', password: password ?? 'CLAVE', cuenta: process.env.CORREO_CUENTA, subcuenta: process.env.CORREO_SUBCUENTA },
      [],
      [listos[0].envio],
    );
    console.log('── Envelope SOAP del primer envío (contraseña redactada) ──');
    console.log(redactar(envelope));
    console.log(
      '\nDRY-RUN: no se mandó nada. Para despachar de verdad:\n' +
        `  --enviar --ambiente ${opts.ambiente}` +
        (opts.ambiente === 'prod' ? ' --confirmo-produccion' : ''),
    );
    return;
  }

  // --- ENVÍO REAL, uno por uno ---------------------------------------------
  fs.mkdirSync(opts.out, { recursive: true });

  let okCount = 0;
  let errCount = 0;
  let sinCodigoCount = 0;

  for (const l of listos) {
    const ref = l.pedido.referencia;
    const base = path.join(opts.out, slug(ref));

    // El marcador va ANTES de la llamada. Si el proceso muere en el medio,
    // queda el rastro de que puede existir un envío sin registrar.
    fs.writeFileSync(
      `${base}.pendiente.json`,
      JSON.stringify(
        { referencia: ref, ambiente: opts.ambiente, iniciado: new Date().toISOString(), envio: l.envio },
        null,
        2,
      ),
    );

    try {
      const res = await cargaMasiva({
        ambiente: opts.ambiente,
        credenciales: {
          user: usuario as string,
          password: password as string,
          cuenta: process.env.CORREO_CUENTA,
          subcuenta: process.env.CORREO_SUBCUENTA,
        },
        envios: [l.envio],
      });

      const envio = res.envios[0];
      const guias = envio?.codigostrazabilidad ?? [];

      // El PDF se guarda DESPUÉS del .ok.json a propósito: el código de
      // trazabilidad es irrecuperable, el PDF no (impresionEtiquetas lo
      // vuelve a emitir con el código). Si algo falla acá, lo que no se puede
      // perder ya está en disco.
      fs.writeFileSync(
        `${base}.ok.json`,
        JSON.stringify(
          {
            referencia: ref,
            ambiente: opts.ambiente,
            despachado: new Date().toISOString(),
            codigosTrazabilidad: guias,
            costos: envio?.costos ?? null,
            codigoRespuesta: res.codigoRespuesta,
            descripcion: res.descripcionRespuesta,
          },
          null,
          2,
        ),
      );
      fs.unlinkSync(`${base}.pendiente.json`);

      if (envio?.etiquetasBase64) {
        fs.writeFileSync(`${base}.etiqueta.pdf`, Buffer.from(envio.etiquetasBase64, 'base64'));
      }
      if (envio?.remitoBase64) {
        fs.writeFileSync(`${base}.remito.pdf`, Buffer.from(envio.remitoBase64, 'base64'));
      }

      if (guias.length === 0) {
        // AHIVA contestó sin error pero sin códigos de trazabilidad. El envío
        // PUEDE existir, así que el .ok.json se deja igual (bloquea un segundo
        // despacho, que es el daño caro). Pero no cuenta como despachado: sin
        // código no hay etiqueta reimprimible ni seguimiento posible.
        sinCodigoCount += 1;
        console.log(
          `  🔴 ${ref}: AHIVA respondió OK pero SIN código de trazabilidad ` +
            `(código=${res.codigoRespuesta} "${res.descripcionRespuesta}").`,
        );
        console.log(
          '       Se dejó el .ok.json para no despachar dos veces. Verificá en "Mis envíos"\n' +
            '       del portal si el envío existe, antes de volver a intentar.',
        );
      } else {
        okCount += 1;
        console.log(
          `  ✅ ${ref} → ${guias.join(', ')}` +
            (envio?.costos ? ` · destinatario $${envio.costos.costoTotalDestinatario}` : ''),
        );
      }
      if (envio?.etiquetasBase64) console.log(`       etiqueta: ${base}.etiqueta.pdf`);
    } catch (err) {
      errCount += 1;
      const e = err as CorreoError;
      // Mismo criterio que correo/process.ts:361, y por el mismo motivo: sólo un
      // rechazo PROBADO de AHIVA autoriza a levantar el marcador. Antes esto
      // deducía "rechazó" de `retryable === false`, que también es cierto para
      // un HTTP 4xx y para un corte de red con un `code` fuera de la lista de
      // `esRed` — incluido el corte MIENTRAS AHIVA devuelve la etiqueta, que es
      // exactamente cuando el envío SÍ existe. Borrar el marcador ahí hace que
      // la corrida siguiente emita una segunda guía con un segundo cobro.
      const esFaultDeNegocio = e instanceof CorreoError && e.esRechazoDeNegocio;

      fs.writeFileSync(
        `${base}.error.json`,
        JSON.stringify(
          {
            referencia: ref,
            fallo: new Date().toISOString(),
            mensaje: e.message,
            codigo: e.codigo ?? null,
            retryable: e.retryable ?? null,
            // Queda asentado si se pudo AFIRMAR que AHIVA no creó nada: es el
            // dato que decide si el marcador se levanta o se conserva.
            rechazoProbado: e instanceof CorreoError ? e.esRechazoDeNegocio : null,
          },
          null,
          2,
        ),
      );

      if (esFaultDeNegocio) {
        // AHIVA rechazó la solicitud: no se creó ningún envío, el marcador se
        // puede levantar sin riesgo de duplicar.
        fs.unlinkSync(`${base}.pendiente.json`);
        console.log(`  ❌ ${ref}: ${e.message}`);
        console.log('       (rechazo de AHIVA — no se creó envío, se puede corregir y reintentar)');
      } else {
        // Red o timeout: NO sabemos si el envío se creó. El marcador queda.
        console.log(`  🔴 ${ref}: ${e.message}`);
        console.log(
          '       MARCADOR PENDIENTE DEJADO A PROPÓSITO: puede haber un envío creado.\n' +
            '       Verificá en "Mis envíos" del portal antes de reintentar.',
        );
      }
    }
  }

  console.log(
    `\n── Resumen ──\n  despachados     : ${okCount}\n` +
      `  sin código (!)  : ${sinCodigoCount}\n` +
      `  con error       : ${errCount}\n  salida          : ${opts.out}`,
  );
  if (errCount > 0 || sinCodigoCount > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\ncargar.ts falló:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

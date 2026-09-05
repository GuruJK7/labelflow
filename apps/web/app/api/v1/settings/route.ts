import { NextRequest } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { correoFeatureEnabled } from '@/lib/correo-feature';
import { normalizarNombreOficina, obtenerNombresOficinas, verificarOficina } from '@/lib/correo-catalogo';
import { codFeatureEnabled } from '@/lib/cod-feature';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { encryptIfPresent, decryptOrRaw } from '@/lib/encryption';
import { shopDomainChangeConflicts, SHOP_DOMAIN_TAKEN_MESSAGE } from '@/lib/shop-domain-taken';
import { startOfDayUy, startOfMonthUy } from '@/lib/uy-time';

const updateSchema = z.object({
  shopifyStoreUrl: z.string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/, 'Must be a valid Shopify domain (e.g. your-store.myshopify.com)')
    // Se guarda en minúsculas: el flujo del App Store (/entry, /claim, el
    // webhook) busca por dominio y Shopify siempre lo manda en minúsculas.
    // Un 'MiTienda.myshopify.com' guardado tal cual era una tienda que el
    // App Store no encontraba y volvía a aprovisionar (D18).
    .transform((s) => s.toLowerCase())
    .optional(),
  shopifyToken: z.string().min(1).optional(),
  dacUsername: z.string().min(1).optional(),
  dacPassword: z.string().min(1).optional(),
  // AutoEnvía Dashboard source (fuente alternativa a Shopify)
  dashboardUrl: z.string().url('URL inválida').optional(),
  dashboardToken: z.string().min(1).optional(),
  dashboardSourceEnabled: z.boolean().optional(),
  emailHost: z.string().min(1).optional(),
  emailPort: z.number().min(1).max(65535).optional(),
  emailUser: z.string().min(1).optional(),
  emailPass: z.string().min(1).optional(),
  emailFrom: z.string().min(1).optional(),
  storeName: z.string().max(100).optional(),
  paymentThreshold: z.number().min(0).max(1000000).optional(),
  paymentRuleEnabled: z.boolean().optional(),
  cronSchedule: z.string()
    .regex(/^(\*|[0-9,\-\/*]+)\s+(\*|[0-9,\-\/*]+)\s+(\*|[0-9,\-\/*]+)\s+(\*|[0-9,\-\/*]+)\s+(\*|[0-9,\-\/*]+)$/, 'Invalid cron expression')
    .refine((val) => {
      const [min] = val.split(' ');
      if (min === '*') return false;
      if (min.startsWith('*/')) return parseInt(min.substring(2)) >= 15;
      return true;
    }, 'Minimum interval is 15 minutes')
    .optional(),
  // 🔴 `min(1)` hacía inalcanzable el centinela `0` = sin tope que el worker
  // SÍ entiende (`process-orders.job.ts`, `isUnlimited`). Una tienda no podía
  // dejar su default en "todos" ni aunque quisiera. Ver lib/limite-por-corrida.ts.
  maxOrdersPerRun: z.number().int().min(0).max(50).optional(),
  scheduleSlots: z.array(z.object({
    time: z.string().regex(/^\d{2}:\d{2}$/),
    maxOrders: z.number().min(0).max(50),
  })).max(10).optional(),
  autoFulfillEnabled: z.boolean().optional(),
  skuInObservations: z.boolean().optional(),
  // Reparto propio: departamentos que el tenant despacha por su cuenta.
  // Se validan contra la lista real en el worker (uruguay-geo); aca solo se
  // acota el tamano para que no entre un array arbitrario.
  selfDeliveryEnabled: z.boolean().optional(),
  selfDeliveryDepartments: z.array(z.string().min(1).max(40)).max(19).nullable().optional(),
  fulfillMode: z.enum(['off', 'on', 'always']).optional(),
  consolidateConsecutiveOrders: z.boolean().optional(),
  consolidationWindowMinutes: z.number().min(1).max(1440).optional(),
  // Contrareembolso (D33/H7): columna existente, sin UI hasta ahora.
  codEnabled: z.boolean().optional(),
  // Correo Uruguayo (AHIVA) como transportista. correoEnabled es el selector:
  // false = la tienda despacha por DAC (como siempre), true = por Correo.
  correoEnabled: z.boolean().optional(),
  correoUser: z.string().max(120).nullable().optional(),
  correoPassword: z.string().max(200).nullable().optional(),
  correoCuenta: z.string().max(60).nullable().optional(),
  correoSubcuenta: z.string().max(60).nullable().optional(),
  correoAmbiente: z.enum(['test', 'prod']).optional(),
  correoOficinaDevolucion: z.string().max(120).nullable().optional(),
  // Correo exige peso (>0 y <30 kg) y DAC nunca lo pidió: sin un default por
  // tienda, todo pedido sin peso propio va a revisión.
  pesoDefaultKg: z.number().positive().lt(30).nullable().optional(),
  defaultPrinter: z.string().max(200).optional(),
  autoPrintEnabled: z.boolean().optional(),
  orderSortDirection: z.enum(['oldest_first', 'newest_first']).optional(),
  allowedProductTypes: z.array(z.string().min(1).max(100)).max(50).nullable().optional(),
  // Auto-payment (DAC/Plexo)
  paymentAutoEnabled: z.boolean().optional(),
  paymentCardBrand: z.enum(['mastercard', 'visa', 'oca']).nullable().optional(),
  paymentCardLast4: z.string().regex(/^\d{4}$/, 'Deben ser 4 digitos').nullable().optional(),
  paymentCardCvc: z.string().regex(/^\d{3,4}$/, 'CVC debe ser 3 o 4 digitos').optional(),
}).partial();

export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: {
      shopifyStoreUrl: true,
      shopifyToken: true,
      dacUsername: true,
      dacPassword: true,
      dashboardUrl: true,
      dashboardToken: true,
      dashboardSourceEnabled: true,
      emailHost: true,
      emailPort: true,
      emailUser: true,
      emailPass: true,
      emailFrom: true,
      storeName: true,
      paymentThreshold: true,
      paymentRuleEnabled: true,
      cronSchedule: true,
      maxOrdersPerRun: true,
      scheduleSlots: true,
      isActive: true,
      subscriptionStatus: true,
      stripePriceId: true,
      stripeSubscriptionId: true,
      currentPeriodEnd: true,
      labelsThisMonth: true,
      labelsTotal: true,
      lastRunAt: true,
      apiKey: true,
      autoFulfillEnabled: true,
      skuInObservations: true,
      selfDeliveryEnabled: true,
      selfDeliveryDepartments: true,
      fulfillMode: true,
      defaultPrinter: true,
      autoPrintEnabled: true,
      orderSortDirection: true,
      allowedProductTypes: true,
      productTypeCache: true,
      consolidateConsecutiveOrders: true,
      consolidationWindowMinutes: true,
      codEnabled: true,
      correoEnabled: true,
      correoUser: true,
      correoPassword: true,
      correoCuenta: true,
      correoSubcuenta: true,
      correoAmbiente: true,
      correoOficinaDevolucion: true,
      pesoDefaultKg: true,
      paymentAutoEnabled: true,
      paymentCardBrand: true,
      paymentCardLast4: true,
      paymentCardCvc: true,
    },
  });

  if (!tenant) return apiError('Tenant no encontrado', 404);

  // Calculate real label counts from Label table.
  //
  // BUGFIX: previous version used `new Date(y, m, d)` which interprets in
  // server-local time. On Vercel that's UTC, so "today" started at 21:00 UY
  // of the previous day — the dashboard misattributed any activity in the
  // 21:00–24:00 UY window every single night. Now using UY-fixed helpers.
  const startOfMonth = startOfMonthUy();
  const startOfDay = startOfDayUy();

  const [labelsThisMonthReal, labelsTodayReal, successThisMonth, resolvedThisMonth] =
    await Promise.all([
      db.label.count({
        where: { tenantId: auth.tenantId, createdAt: { gte: startOfMonth } },
      }),
      db.label.count({
        where: { tenantId: auth.tenantId, createdAt: { gte: startOfDay } },
      }),
      // Tasa de exito REAL (desde la tabla Label, no desde Job).
      // "exito" = CREATED|COMPLETED (envio con guia DAC capturada), la misma
      // convencion que usa el resto de la app (labelsToday/mes, panel admin).
      db.label.count({
        where: {
          tenantId: auth.tenantId,
          createdAt: { gte: startOfMonth },
          status: { in: ['CREATED', 'COMPLETED'] },
        },
      }),
      // "resueltos" = todo lo que dejo de estar en vuelo: exitos + FAILED +
      // NEEDS_REVIEW (orphan / silent-reject). Excluye PENDING (aun se esta
      // procesando) y SKIPPED (no se intento despachar). Incluir NEEDS_REVIEW
      // es lo clave: un orphan SIN guia capturada cuenta como fallo, no se
      // esconde. Asi la tasa nunca puede superar 100% (exitos ⊆ resueltos).
      db.label.count({
        where: {
          tenantId: auth.tenantId,
          createdAt: { gte: startOfMonth },
          status: { in: ['CREATED', 'COMPLETED', 'FAILED', 'NEEDS_REVIEW'] },
        },
      }),
    ]);

  // Una decimal. 100% cuando todavia no hay envios resueltos este mes
  // (evita mostrar 0% en una tienda nueva sin actividad).
  const successRate =
    resolvedThisMonth > 0
      ? Math.round((successThisMonth / resolvedThisMonth) * 1000) / 10
      : 100;

  // Never return encrypted values, return booleans instead
  return apiSuccess({
    shopifyStoreUrl: tenant.shopifyStoreUrl,
    shopifyTokenSet: !!tenant.shopifyToken,
    dacUsername: decryptOrRaw(tenant.dacUsername),
    dacPasswordSet: !!tenant.dacPassword,
    dashboardUrl: tenant.dashboardUrl,
    dashboardTokenSet: !!tenant.dashboardToken,
    dashboardSourceEnabled: tenant.dashboardSourceEnabled,
    emailHost: tenant.emailHost,
    emailPort: tenant.emailPort,
    emailUser: tenant.emailUser,
    emailPassSet: !!tenant.emailPass,
    emailFrom: tenant.emailFrom,
    storeName: tenant.storeName,
    paymentThreshold: tenant.paymentThreshold,
    paymentRuleEnabled: tenant.paymentRuleEnabled,
    cronSchedule: tenant.cronSchedule,
    maxOrdersPerRun: tenant.maxOrdersPerRun,
    scheduleSlots: tenant.scheduleSlots,
    autoFulfillEnabled: tenant.autoFulfillEnabled,
    skuInObservations: tenant.skuInObservations,
    selfDeliveryEnabled: tenant.selfDeliveryEnabled,
    selfDeliveryDepartments: tenant.selfDeliveryDepartments,
    fulfillMode: tenant.fulfillMode,
    isActive: tenant.isActive,
    subscriptionStatus: tenant.subscriptionStatus,
    stripePriceId: tenant.stripePriceId,
    stripeSubscriptionId: tenant.stripeSubscriptionId,
    currentPeriodEnd: tenant.currentPeriodEnd,
    labelsThisMonth: labelsThisMonthReal,
    labelsToday: labelsTodayReal,
    successRate,
    labelsTotal: tenant.labelsTotal,
    lastRunAt: tenant.lastRunAt,
    apiKey: tenant.apiKey,
    defaultPrinter: tenant.defaultPrinter,
    autoPrintEnabled: tenant.autoPrintEnabled,
    orderSortDirection: tenant.orderSortDirection,
    allowedProductTypes: tenant.allowedProductTypes,
    productTypeCache: tenant.productTypeCache,
    consolidateConsecutiveOrders: tenant.consolidateConsecutiveOrders,
    consolidationWindowMinutes: tenant.consolidationWindowMinutes,
    codEnabled: tenant.codEnabled,
    // El secreto nunca vuelve: sólo si está cargado, igual que dacPasswordSet.
    correoAvailable: correoFeatureEnabled(),
    correoEnabled: tenant.correoEnabled,
    correoUser: decryptOrRaw(tenant.correoUser),
    correoPasswordSet: !!tenant.correoPassword,
    correoCuenta: decryptOrRaw(tenant.correoCuenta),
    // Se devuelve el VALOR, no sólo un booleano: la cuenta ya se devolvía así y
    // la subcuenta es del mismo tipo de dato (identificador de la cuenta en
    // AHIVA, no un secreto). Con sólo el booleano el campo era invisible y
    // —peor— imborrable: el form sólo lo mandaba si tenía texto, así que una vez
    // cargado se seguía enviando en cada envelope para siempre.
    correoSubcuenta: decryptOrRaw(tenant.correoSubcuenta),
    correoSubcuentaSet: !!tenant.correoSubcuenta,
    correoAmbiente: tenant.correoAmbiente,
    correoOficinaDevolucion: tenant.correoOficinaDevolucion,
    pesoDefaultKg: tenant.pesoDefaultKg,
    // Revisión 2026-09-02: el toggle sólo se ofrece si el worker desplegado lo
    // honra (COD_FEATURE_ENABLED). Ver lib/cod-feature.ts.
    codAvailable: codFeatureEnabled(),
    // Auto-payment config — never leak CVC, return boolean "set" instead
    paymentAutoEnabled: tenant.paymentAutoEnabled,
    paymentCardBrand: tenant.paymentCardBrand,
    paymentCardLast4: tenant.paymentCardLast4,
    paymentCardCvcSet: !!tenant.paymentCardCvc,
  });
}

export async function PUT(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const body = await req.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('Datos inválidos', 400);
  }

  const data: Record<string, unknown> = {};
  const input = parsed.data;

  // Un dominio de Shopify pertenece a UN tenant. Mismo chequeo que hacen
  // /api/shopify/install, /claim y onboarding/test-shopify (lib/shop-domain-taken):
  // sin él, dos cuentas podían apuntar a la misma tienda cargando el token a
  // mano, y el worker despachaba cada pedido dos veces. Insensible a mayúsculas
  // (D18) y sólo cuando el dominio CAMBIA: "Guardar token" manda siempre el
  // dominio que cargó del GET, y los tenants que comparten tienda a propósito
  // tienen que poder rotar el token (D21).
  if (input.shopifyStoreUrl !== undefined) {
    if (await shopDomainChangeConflicts(input.shopifyStoreUrl, auth.tenantId)) {
      return apiError(SHOP_DOMAIN_TAKEN_MESSAGE, 409);
    }
  }

  // Plain fields
  if (input.shopifyStoreUrl !== undefined) data.shopifyStoreUrl = input.shopifyStoreUrl;
  if (input.dashboardUrl !== undefined) data.dashboardUrl = input.dashboardUrl;
  if (input.dashboardSourceEnabled !== undefined) data.dashboardSourceEnabled = input.dashboardSourceEnabled;
  if (input.emailHost !== undefined) data.emailHost = input.emailHost;
  if (input.emailPort !== undefined) data.emailPort = input.emailPort;
  if (input.emailUser !== undefined) data.emailUser = input.emailUser;
  if (input.emailFrom !== undefined) data.emailFrom = input.emailFrom;
  if (input.storeName !== undefined) data.storeName = input.storeName;
  if (input.paymentThreshold !== undefined) data.paymentThreshold = input.paymentThreshold;
  if (input.paymentRuleEnabled !== undefined) data.paymentRuleEnabled = input.paymentRuleEnabled;
  if (input.cronSchedule !== undefined) data.cronSchedule = input.cronSchedule;
  if (input.maxOrdersPerRun !== undefined) data.maxOrdersPerRun = input.maxOrdersPerRun;
  if (input.scheduleSlots !== undefined) data.scheduleSlots = input.scheduleSlots;
  if (input.autoFulfillEnabled !== undefined) data.autoFulfillEnabled = input.autoFulfillEnabled;
  if (input.skuInObservations !== undefined) data.skuInObservations = input.skuInObservations;
  if (input.selfDeliveryEnabled !== undefined) data.selfDeliveryEnabled = input.selfDeliveryEnabled;
  if (input.selfDeliveryDepartments !== undefined) data.selfDeliveryDepartments = input.selfDeliveryDepartments;
  if (input.fulfillMode !== undefined) {
    data.fulfillMode = input.fulfillMode;
    // Sync legacy boolean field
    data.autoFulfillEnabled = input.fulfillMode !== 'off';
  }
  if (input.defaultPrinter !== undefined) data.defaultPrinter = input.defaultPrinter;
  if (input.autoPrintEnabled !== undefined) data.autoPrintEnabled = input.autoPrintEnabled;
  if (input.orderSortDirection !== undefined) data.orderSortDirection = input.orderSortDirection;
  if (input.allowedProductTypes !== undefined) data.allowedProductTypes = input.allowedProductTypes;
  if (input.consolidateConsecutiveOrders !== undefined) data.consolidateConsecutiveOrders = input.consolidateConsecutiveOrders;
  if (input.consolidationWindowMinutes !== undefined) data.consolidationWindowMinutes = input.consolidationWindowMinutes;
  if (input.codEnabled !== undefined) {
    // Prender el contrareembolso promete algo que sólo cumple el worker
    // desplegado con df13204; hasta que Adrian lo confirme (COD_FEATURE_ENABLED)
    // no se persiste un `true`. Apagarlo siempre se puede.
    if (input.codEnabled && !codFeatureEnabled()) {
      return apiError('El contrareembolso todavía no está disponible. Avisamos cuando se pueda prender.', 422);
    }
    data.codEnabled = input.codEnabled;
  }

  if (input.correoAmbiente !== undefined) data.correoAmbiente = input.correoAmbiente;

  // La oficina de devolución se valida ACÁ, contra el catálogo de Correo.
  //
  // 🔴 Es una configuración POR TIENDA que el worker chequea POR PEDIDO: un
  // nombre que no existe hace que `construirEnvio` devuelva motivo y el pedido
  // vaya a NEEDS_REVIEW. Como el valor es de la tienda, un solo nombre mal
  // escrito manda el 100% de sus envíos a revisión, corrida tras corrida, sin
  // que nadie entienda por qué. Se valida cuando hay una persona mirando la
  // pantalla, y se guarda el nombre CANÓNICO del catálogo (AHIVA identifica la
  // sucursal por el texto exacto, con su acentuación propia).
  if (input.correoOficinaDevolucion !== undefined) {
    const pedida = (input.correoOficinaDevolucion ?? '').trim();
    if (!pedida) {
      data.correoOficinaDevolucion = null;
    } else {
      // El form manda SIEMPRE el bloque completo del transportista, así que este
      // campo llega también cuando el comerciante sólo quiso apagar Correo o
      // corregir sus credenciales. Se lee el estado guardado para decidir si
      // hace falta salir a la red.
      const tenantCorreo = await db.tenant.findUnique({
        where: { id: auth.tenantId },
        select: { correoAmbiente: true, correoOficinaDevolucion: true, correoEnabled: true },
      });

      // 🔴 APAGAR CORREO NO PUEDE DEPENDER DE QUE CORREO ESTÉ VIVO. Si el PUT
      // deja el transportista apagado, o ya estaba apagado y no se prende, el
      // valor se guarda tal cual sin verificarlo: no se despacha nada por esa
      // vía, así que un nombre inválido no puede romper ningún envío, y exigir
      // el catálogo justo cuando AHIVA está caído convertía el interruptor de
      // emergencia en un candado — el 503 abortaba el PUT entero y ni siquiera
      // dejaba corregir las credenciales.
      const quedaraApagado =
        input.correoEnabled === false || (input.correoEnabled === undefined && !tenantCorreo?.correoEnabled);
      // Y si el nombre no cambió respecto del que ya estaba guardado, tampoco
      // hay nada que verificar: ya pasó por acá cuando se guardó.
      const sinCambios =
        !!tenantCorreo?.correoOficinaDevolucion &&
        normalizarNombreOficina(tenantCorreo.correoOficinaDevolucion) === normalizarNombreOficina(pedida);

      if (quedaraApagado || sinCambios) {
        data.correoOficinaDevolucion = sinCambios ? tenantCorreo!.correoOficinaDevolucion : pedida;
      } else {
        const ambienteActual = input.correoAmbiente ?? tenantCorreo?.correoAmbiente;
        const ambiente = ambienteActual === 'prod' ? 'prod' : 'test';
        let catalogo: string[];
        try {
          catalogo = await obtenerNombresOficinas(ambiente);
        } catch {
          // Fail-closed sólo acá: se está PRENDIENDO o cambiando la agencia de
          // una tienda que va a despachar por Correo. Aceptarla sin verificar
          // manda el 100% de sus envíos a revisión, corrida tras corrida.
          return apiError(
            'No se pudo verificar la oficina de devolución contra el catálogo de Correo Uruguayo. ' +
              'Probá de nuevo en un momento.',
            503,
          );
        }
        const chequeo = verificarOficina(pedida, catalogo);
        if (!chequeo.ok) {
          return apiError(
            `La oficina de devolución "${pedida}" no existe en el catálogo de Correo Uruguayo` +
              (chequeo.sugerencias.length ? `. ¿Quisiste decir: ${chequeo.sugerencias.join(' · ')}?` : '.'),
            422,
          );
        }
        data.correoOficinaDevolucion = chequeo.nombre;
      }
    }
  }
  if (input.pesoDefaultKg !== undefined) data.pesoDefaultKg = input.pesoDefaultKg;
  if (input.correoEnabled !== undefined) {
    // Se leen las credenciales guardadas para poder validar "prender Correo"
    // cuando el usuario prende el toggle sin re-tipear la contraseña (el GET
    // nunca devuelve el secreto, así que el form manda sólo el flag).
    const tenantActual = input.correoEnabled
      ? await db.tenant.findUnique({
          where: { id: auth.tenantId },
          select: { correoUser: true, correoPassword: true, pesoDefaultKg: true },
        })
      : null;
    // Prender Correo cambia el transportista de TODOS los envíos de la tienda.
    // Sin credenciales, el job fallaría entero en cada corrida y el comerciante
    // vería "falló" sin entender por qué, así que se rechaza acá con el motivo.
    if (input.correoEnabled) {
      if (!correoFeatureEnabled()) {
        return apiError('Correo Uruguayo todavía no está disponible. Avisamos cuando se pueda prender.', 422);
      }
      const userFinal = input.correoUser !== undefined ? input.correoUser : decryptOrRaw(tenantActual?.correoUser);
      const passFinal = input.correoPassword !== undefined ? input.correoPassword : tenantActual?.correoPassword;
      if (!userFinal || !passFinal) {
        return apiError(
          'Para despachar por Correo Uruguayo hay que cargar primero el usuario y la contraseña de AHIVA.',
          422,
        );
      }
      // Sin peso por defecto, Correo rechaza TODOS los pedidos que no traigan el
      // suyo — que en la práctica son todos, porque DAC nunca pidió peso y
      // ninguna tienda lo tiene cargado en Shopify. Prender el transportista sin
      // esto deja la tienda sin despachar nada y sin entender por qué.
      const pesoFinal = input.pesoDefaultKg !== undefined ? input.pesoDefaultKg : tenantActual?.pesoDefaultKg;
      if (!pesoFinal || pesoFinal <= 0) {
        return apiError(
          'Correo Uruguayo exige el peso de cada paquete. Cargá un peso por defecto (en kg) antes de prenderlo.',
          422,
        );
      }
    }
    data.correoEnabled = input.correoEnabled;
  }

  // Auto-payment (plain fields)
  if (input.paymentAutoEnabled !== undefined) data.paymentAutoEnabled = input.paymentAutoEnabled;
  if (input.paymentCardBrand !== undefined) data.paymentCardBrand = input.paymentCardBrand;
  if (input.paymentCardLast4 !== undefined) data.paymentCardLast4 = input.paymentCardLast4;

  // Encrypted fields
  if (input.shopifyToken !== undefined) data.shopifyToken = encryptIfPresent(input.shopifyToken);
  if (input.dashboardToken !== undefined) data.dashboardToken = encryptIfPresent(input.dashboardToken);
  if (input.dacUsername !== undefined) data.dacUsername = encryptIfPresent(input.dacUsername);
  if (input.dacPassword !== undefined) data.dacPassword = encryptIfPresent(input.dacPassword);
  if (input.correoUser !== undefined) data.correoUser = encryptIfPresent(input.correoUser);
  if (input.correoPassword !== undefined) data.correoPassword = encryptIfPresent(input.correoPassword);
  if (input.correoCuenta !== undefined) data.correoCuenta = encryptIfPresent(input.correoCuenta);
  if (input.correoSubcuenta !== undefined) data.correoSubcuenta = encryptIfPresent(input.correoSubcuenta);
  if (input.emailPass !== undefined) data.emailPass = encryptIfPresent(input.emailPass);
  if (input.paymentCardCvc !== undefined) data.paymentCardCvc = encryptIfPresent(input.paymentCardCvc);

  // Verify Shopify connection if token provided
  if (input.shopifyToken && input.shopifyStoreUrl) {
    try {
      const res = await fetch(
        `https://${input.shopifyStoreUrl}/admin/api/2024-01/shop.json`,
        {
          headers: { 'X-Shopify-Access-Token': input.shopifyToken },
        }
      );
      if (!res.ok) {
        return apiError('No se pudo conectar a Shopify. Verifica la URL y el token.', 422);
      }
    } catch {
      return apiError('Error verificando conexion a Shopify', 422);
    }
  }

  await db.tenant.update({
    where: { id: auth.tenantId },
    data,
  });

  // If DAC credentials changed, invalidate cached Playwright session cookies so the
  // worker logs in fresh with the new creds on the next cycle. Without this, the
  // worker can keep riding an active DAC session belonging to the *previous* user
  // for up to 4h (cookie TTL), silently filing guias under the wrong account.
  if (input.dacUsername !== undefined || input.dacPassword !== undefined) {
    await db.runLog.deleteMany({
      where: { tenantId: auth.tenantId, message: 'dac_cookies' },
    });
  }

  return apiSuccess({ message: 'Configuracion actualizada' });
}

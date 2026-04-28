/**
 * Dark-themed UI illustrations of each Shopify Admin / Dev Dashboard screen
 * the user will hit while creating their Admin API token.
 *
 * Why illustrations and not real screenshots:
 *   1. Privacy — real captures from the operator's KARBON store would leak
 *      brand-specific UI to anyone visiting the public tutorial.
 *   2. Stability — Shopify ships UI changes constantly. SVGs that match
 *      the *meaning* (button names, layout, click target) survive minor
 *      visual refreshes; bitmap screenshots silently rot.
 *   3. Performance — these inline SVGs are <2KB each, no extra HTTP round
 *      trips, look pixel-perfect at any DPR, and theme-match the rest of
 *      the dashboard.
 *
 * Every label, button name and URL fragment in these illustrations was
 * verified by driving Chrome through the live flow on a real Shopify store
 * on 2026-04-28. If you change wording here, run the flow again first.
 *
 * Each `<marker id="...">` MUST be unique across the page — duplicate ids
 * across SVGs cause `markerEnd="url(#id)"` to resolve unpredictably under
 * Safari/Webkit. We pass a per-SVG id to ArrowDefs to avoid this.
 */

type MockProps = { className?: string };

/** Reusable arrow-marker defs. Each SVG gets a unique id to keep the DOM
 *  free of id collisions when many mocks render together. */
function ArrowDefs({ id }: { id: string }) {
  return (
    <defs>
      <marker
        id={id}
        markerWidth="10"
        markerHeight="10"
        refX="6"
        refY="3"
        orient="auto"
      >
        <polygon points="0 0, 6 3, 0 6" fill="#22d3ee" />
      </marker>
    </defs>
  );
}

/** Step 1: admin.shopify.com → "Configuración" link in lower-left sidebar. */
export function MockSettings({ className }: MockProps) {
  const arrowId = 'mock-arrow-settings';
  return (
    <svg
      viewBox="0 0 800 460"
      role="img"
      aria-label="Ilustración: clic en Configuración del admin de Shopify"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <ArrowDefs id={arrowId} />
      {/* Window chrome */}
      <rect x="0" y="0" width="800" height="460" rx="10" fill="#0b1220" />
      <rect x="0" y="0" width="800" height="36" rx="10" fill="#111827" />
      <circle cx="20" cy="18" r="5" fill="#ef4444" />
      <circle cx="38" cy="18" r="5" fill="#f59e0b" />
      <circle cx="56" cy="18" r="5" fill="#10b981" />
      <rect x="160" y="8" width="380" height="20" rx="6" fill="#1f2937" />
      <text x="180" y="22" fontSize="11" fill="#6b7280" fontFamily="monospace">
        admin.shopify.com/store/...
      </text>
      {/* Sidebar */}
      <rect x="0" y="36" width="220" height="424" fill="#0a0f1a" />
      {[
        'Inicio',
        'Pedidos',
        'Productos',
        'Clientes',
        'Marketing',
        'Descuentos',
        'Análisis',
        'Canales de venta',
        'Aplicaciones',
      ].map((label, i) => (
        <g key={label}>
          <rect
            x="12"
            y={62 + i * 30}
            width="196"
            height="22"
            rx="4"
            fill="transparent"
          />
          <text x="28" y={77 + i * 30} fontSize="12" fill="#9ca3af">
            {label}
          </text>
        </g>
      ))}
      {/* Configuración highlighted */}
      <rect
        x="12"
        y="392"
        width="196"
        height="32"
        rx="6"
        fill="rgba(34,211,238,0.12)"
        stroke="#22d3ee"
        strokeWidth="2"
      />
      <text x="28" y="412" fontSize="13" fill="#22d3ee" fontWeight="600">
        ⚙  Configuración
      </text>
      {/* Main panel placeholder */}
      <rect x="240" y="60" width="540" height="60" rx="8" fill="#111827" />
      <text x="260" y="92" fontSize="16" fill="#e5e7eb" fontWeight="600">
        Inicio
      </text>
      <rect x="240" y="140" width="540" height="280" rx="8" fill="#0f172a" />
      {/* Pointer arrow */}
      <line
        x1="290"
        y1="408"
        x2="218"
        y2="408"
        stroke="#22d3ee"
        strokeWidth="2.5"
        markerEnd={`url(#${arrowId})`}
      />
      <text x="298" y="412" fontSize="13" fill="#22d3ee" fontWeight="600">
        Hacé clic aquí
      </text>
    </svg>
  );
}

/** Step 2: Configuración → Apps y canales de venta → Desarrollar apps. */
export function MockDevelopApps({ className }: MockProps) {
  const arrowId = 'mock-arrow-develop';
  return (
    <svg
      viewBox="0 0 800 460"
      role="img"
      aria-label="Ilustración: botón Desarrollar apps en Dev Dashboard"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <ArrowDefs id={arrowId} />
      <rect x="0" y="0" width="800" height="460" rx="10" fill="#0b1220" />
      <rect x="0" y="0" width="800" height="36" rx="10" fill="#111827" />
      <circle cx="20" cy="18" r="5" fill="#ef4444" />
      <circle cx="38" cy="18" r="5" fill="#f59e0b" />
      <circle cx="56" cy="18" r="5" fill="#10b981" />
      <rect x="160" y="8" width="500" height="20" rx="6" fill="#1f2937" />
      <text x="180" y="22" fontSize="11" fill="#6b7280" fontFamily="monospace">
        admin.shopify.com/store/.../settings/apps/development
      </text>
      {/* Sidebar (settings-style: shorter list) */}
      <rect x="0" y="36" width="240" height="424" fill="#0a0f1a" />
      <text x="20" y="62" fontSize="12" fill="#6b7280" fontWeight="600">
        Configuración
      </text>
      {[
        'General',
        'Plan',
        'Facturación',
        'Usuarios',
        'Pagos',
        'Checkout',
        'Envíos y entregas',
        'Impuestos',
        'Notificaciones',
      ].map((label, i) => (
        <text
          key={label}
          x="28"
          y={92 + i * 26}
          fontSize="12"
          fill="#9ca3af"
        >
          {label}
        </text>
      ))}
      <rect
        x="12"
        y="320"
        width="220"
        height="28"
        rx="6"
        fill="rgba(34,211,238,0.12)"
        stroke="#22d3ee"
        strokeWidth="1.5"
      />
      <text x="28" y="338" fontSize="12" fill="#22d3ee" fontWeight="600">
        Apps y canales de venta
      </text>
      {/* Header */}
      <text x="270" y="80" fontSize="18" fill="#f8fafc" fontWeight="600">
        Desarrollo de apps
      </text>
      <text x="270" y="104" fontSize="12" fill="#6b7280">
        Creá apps personalizadas para integrar servicios externos a tu tienda.
      </text>
      {/* CTA card */}
      <rect
        x="270"
        y="140"
        width="500"
        height="160"
        rx="10"
        fill="#0f172a"
        stroke="#1f2937"
      />
      <text x="290" y="172" fontSize="14" fill="#e5e7eb" fontWeight="600">
        Desarrollá apps personalizadas con Dev Dashboard
      </text>
      <text x="290" y="196" fontSize="12" fill="#6b7280">
        Creá apps con Admin API en el Dev Dashboard de Shopify, donde podés
      </text>
      <text x="290" y="214" fontSize="12" fill="#6b7280">
        gestionar permisos, versiones y tokens.
      </text>
      {/* Highlighted button */}
      <rect
        x="290"
        y="244"
        width="280"
        height="40"
        rx="8"
        fill="rgba(34,211,238,0.15)"
        stroke="#22d3ee"
        strokeWidth="2"
      />
      <text x="306" y="269" fontSize="13" fill="#22d3ee" fontWeight="600">
        Desarrollar apps en Dev Dashboard →
      </text>
      <line
        x1="600"
        y1="264"
        x2="572"
        y2="264"
        stroke="#22d3ee"
        strokeWidth="2.5"
        markerEnd={`url(#${arrowId})`}
      />
      <text x="608" y="268" fontSize="12" fill="#22d3ee" fontWeight="600">
        Hacé clic aquí
      </text>
    </svg>
  );
}

/** Step 3: dev.shopify.com/dashboard/<id>/apps → Crear app. */
export function MockCreateApp({ className }: MockProps) {
  const arrowId = 'mock-arrow-create';
  return (
    <svg
      viewBox="0 0 800 460"
      role="img"
      aria-label="Ilustración: botón Crear app en Dev Dashboard"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <ArrowDefs id={arrowId} />
      <rect x="0" y="0" width="800" height="460" rx="10" fill="#0b1220" />
      <rect x="0" y="0" width="800" height="36" rx="10" fill="#111827" />
      <circle cx="20" cy="18" r="5" fill="#ef4444" />
      <circle cx="38" cy="18" r="5" fill="#f59e0b" />
      <circle cx="56" cy="18" r="5" fill="#10b981" />
      <rect x="160" y="8" width="500" height="20" rx="6" fill="#1f2937" />
      <text x="180" y="22" fontSize="11" fill="#6b7280" fontFamily="monospace">
        dev.shopify.com/dashboard/.../apps
      </text>
      {/* Top tabs */}
      <rect x="0" y="36" width="800" height="40" fill="#0a0f1a" />
      <text x="40" y="60" fontSize="12" fill="#9ca3af">
        Apps
      </text>
      <text x="120" y="60" fontSize="12" fill="#6b7280">
        Tiendas
      </text>
      <text x="200" y="60" fontSize="12" fill="#6b7280">
        Organización
      </text>
      <line x1="32" y1="68" x2="80" y2="68" stroke="#22d3ee" strokeWidth="2" />
      {/* Empty state card */}
      <rect
        x="100"
        y="120"
        width="600"
        height="220"
        rx="12"
        fill="#0f172a"
        stroke="#1f2937"
      />
      <text
        x="400"
        y="180"
        fontSize="18"
        fill="#f8fafc"
        fontWeight="600"
        textAnchor="middle"
      >
        Aún no tenés apps
      </text>
      <text
        x="400"
        y="208"
        fontSize="13"
        fill="#6b7280"
        textAnchor="middle"
      >
        Empezá creando tu primera app personalizada para conectar con tu tienda.
      </text>
      {/* Big highlighted CTA */}
      <rect
        x="316"
        y="244"
        width="168"
        height="44"
        rx="10"
        fill="#22d3ee"
        stroke="#67e8f9"
        strokeWidth="2"
      />
      <text
        x="400"
        y="271"
        fontSize="14"
        fill="#0b1220"
        fontWeight="700"
        textAnchor="middle"
      >
        + Crear app
      </text>
      <line
        x1="540"
        y1="266"
        x2="488"
        y2="266"
        stroke="#22d3ee"
        strokeWidth="2.5"
        markerEnd={`url(#${arrowId})`}
      />
      <text x="546" y="270" fontSize="12" fill="#22d3ee" fontWeight="600">
        Hacé clic aquí
      </text>
    </svg>
  );
}

/** Step 4: choose "Empezar desde Dev Dashboard". */
export function MockChooseDashboard({ className }: MockProps) {
  const arrowId = 'mock-arrow-choose';
  return (
    <svg
      viewBox="0 0 800 420"
      role="img"
      aria-label="Ilustración: elegir Empezar desde Dev Dashboard"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <ArrowDefs id={arrowId} />
      <rect x="0" y="0" width="800" height="420" rx="10" fill="#0b1220" />
      <rect x="0" y="0" width="800" height="36" rx="10" fill="#111827" />
      <circle cx="20" cy="18" r="5" fill="#ef4444" />
      <circle cx="38" cy="18" r="5" fill="#f59e0b" />
      <circle cx="56" cy="18" r="5" fill="#10b981" />
      <text x="180" y="22" fontSize="11" fill="#6b7280" fontFamily="monospace">
        dev.shopify.com/dashboard/.../apps/new
      </text>
      <text x="40" y="80" fontSize="18" fill="#f8fafc" fontWeight="600">
        Crear una app
      </text>
      <text x="40" y="104" fontSize="12" fill="#6b7280">
        Elegí cómo querés empezar.
      </text>
      {/* CLI option */}
      <rect
        x="40"
        y="140"
        width="340"
        height="200"
        rx="12"
        fill="#0f172a"
        stroke="#1f2937"
        strokeWidth="2"
      />
      <text x="60" y="172" fontSize="14" fill="#9ca3af" fontWeight="600">
        Empezar con Shopify CLI
      </text>
      <text x="60" y="200" fontSize="11" fill="#6b7280">
        Para devs que quieren scaffolding
      </text>
      <text x="60" y="216" fontSize="11" fill="#6b7280">
        local con Node/Ruby/PHP.
      </text>
      <rect x="60" y="280" width="120" height="32" rx="6" fill="#1f2937" />
      <text x="120" y="300" fontSize="12" fill="#9ca3af" textAnchor="middle">
        Empezar con CLI
      </text>
      {/* Dashboard option (highlighted) */}
      <rect
        x="420"
        y="140"
        width="340"
        height="200"
        rx="12"
        fill="rgba(34,211,238,0.08)"
        stroke="#22d3ee"
        strokeWidth="2"
      />
      <text x="440" y="172" fontSize="14" fill="#22d3ee" fontWeight="700">
        Empezar desde Dev Dashboard
      </text>
      <text x="440" y="200" fontSize="11" fill="#9ca3af">
        Configurás permisos en el panel y
      </text>
      <text x="440" y="216" fontSize="11" fill="#9ca3af">
        obtenés un token de Admin API.
      </text>
      <text x="440" y="240" fontSize="11" fill="#22d3ee" fontWeight="600">
        ✓ Esta es la opción que querés
      </text>
      <rect
        x="440"
        y="280"
        width="180"
        height="36"
        rx="8"
        fill="#22d3ee"
      />
      <text
        x="530"
        y="302"
        fontSize="12"
        fill="#0b1220"
        fontWeight="700"
        textAnchor="middle"
      >
        Empezar desde Dashboard
      </text>
      <line
        x1="660"
        y1="298"
        x2="624"
        y2="298"
        stroke="#22d3ee"
        strokeWidth="2.5"
        markerEnd={`url(#${arrowId})`}
      />
      <text x="668" y="302" fontSize="12" fill="#22d3ee" fontWeight="600">
        Hacé clic
      </text>
    </svg>
  );
}

/** Step 5/6: Acceso section with "Seleccionar alcances" and the legacy checkbox. */
export function MockAccessSection({ className }: MockProps) {
  const arrowId = 'mock-arrow-access';
  return (
    <svg
      viewBox="0 0 800 540"
      role="img"
      aria-label="Ilustración: sección Acceso con checkbox de instalación heredada"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <ArrowDefs id={arrowId} />
      <rect x="0" y="0" width="800" height="540" rx="10" fill="#0b1220" />
      <rect x="0" y="0" width="800" height="36" rx="10" fill="#111827" />
      <circle cx="20" cy="18" r="5" fill="#ef4444" />
      <circle cx="38" cy="18" r="5" fill="#f59e0b" />
      <circle cx="56" cy="18" r="5" fill="#10b981" />
      <text x="180" y="22" fontSize="11" fill="#6b7280" fontFamily="monospace">
        dev.shopify.com/dashboard/.../apps/.../versions/new
      </text>
      {/* Header */}
      <text x="40" y="76" fontSize="16" fill="#f8fafc" fontWeight="700">
        Acceso
      </text>
      <text x="40" y="98" fontSize="12" fill="#6b7280">
        Configurá los permisos que tu app va a pedir.
      </text>
      {/* Alcances label + button */}
      <text x="40" y="138" fontSize="13" fill="#e5e7eb" fontWeight="600">
        Alcances
      </text>
      <rect
        x="600"
        y="120"
        width="160"
        height="32"
        rx="6"
        fill="rgba(34,211,238,0.12)"
        stroke="#22d3ee"
        strokeWidth="2"
      />
      <text x="680" y="140" fontSize="12" fill="#22d3ee" fontWeight="700" textAnchor="middle">
        Seleccionar alcances
      </text>
      <line
        x1="585"
        y1="136"
        x2="600"
        y2="136"
        stroke="#22d3ee"
        strokeWidth="2.5"
        markerEnd={`url(#${arrowId})`}
      />
      {/* Textarea */}
      <rect
        x="40"
        y="160"
        width="720"
        height="80"
        rx="8"
        fill="#0f172a"
        stroke="#1f2937"
      />
      <text x="56" y="186" fontSize="11" fill="#475569" fontFamily="monospace">
        read_orders, write_orders, read_fulfillments, write_fulfillments,
      </text>
      <text x="56" y="202" fontSize="11" fill="#475569" fontFamily="monospace">
        read_products, write_products, ...
      </text>
      {/* Helper text */}
      <text x="40" y="262" fontSize="11" fill="#6b7280">
        Estos alcances son necesarios para que tu app funcione. Introducí los alcances separados por comas.
      </text>
      {/* Legacy install checkbox — the critical bit */}
      <rect
        x="40"
        y="300"
        width="720"
        height="78"
        rx="10"
        fill="rgba(245,158,11,0.06)"
        stroke="#f59e0b"
        strokeWidth="2"
      />
      <rect
        x="60"
        y="320"
        width="18"
        height="18"
        rx="4"
        fill="#f59e0b"
      />
      <path
        d="M64 329 L68 333 L74 325"
        stroke="#0b1220"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="92" y="334" fontSize="13" fill="#fbbf24" fontWeight="700">
        Usar flujo de instalación heredado
      </text>
      <text x="92" y="354" fontSize="11" fill="#fde68a">
        ⚠ CRÍTICO — Sin este tilde Shopify NO te entrega un token shpat_,
      </text>
      <text x="92" y="370" fontSize="11" fill="#fde68a">
        sino que te obliga a un flujo OAuth que LabelFlow no soporta.
      </text>
      {/* Publicar button at the bottom */}
      <rect
        x="660"
        y="460"
        width="100"
        height="36"
        rx="8"
        fill="#22d3ee"
      />
      <text
        x="710"
        y="482"
        fontSize="12"
        fill="#0b1220"
        fontWeight="700"
        textAnchor="middle"
      >
        Publicar
      </text>
      <text x="40" y="476" fontSize="11" fill="#6b7280">
        Una vez configurado todo, publicá la versión para que el token quede activo.
      </text>
    </svg>
  );
}

/** Step 7: scope picker modal with a search box and list. */
export function MockScopePicker({ className }: MockProps) {
  const rows = [
    { resource: 'Orders', api: 'Admin API', scopes: ['read_orders', 'write_orders'] },
    {
      resource: 'Fulfillment services',
      api: 'Admin API',
      scopes: ['read_fulfillments', 'write_fulfillments'],
    },
    {
      resource: 'Products',
      api: 'Admin API',
      scopes: ['read_products', 'write_products'],
    },
    {
      resource: 'Assigned fulfillment',
      api: 'Admin API',
      scopes: ['read_assigned_fulfillment_orders', 'write_assigned_fulfillment_orders'],
    },
    {
      resource: 'Merchant managed fulfillment',
      api: 'Admin API',
      scopes: [
        'read_merchant_managed_fulfillment_orders',
        'write_merchant_managed_fulfillment_orders',
      ],
    },
  ];
  return (
    <svg
      viewBox="0 0 800 540"
      role="img"
      aria-label="Ilustración: modal Seleccionar alcances con los 10 alcances tildados"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width="800" height="540" rx="10" fill="#0b1220" />
      {/* Modal */}
      <rect x="40" y="30" width="720" height="480" rx="12" fill="#0f172a" stroke="#1f2937" strokeWidth="2" />
      <text x="60" y="64" fontSize="15" fill="#f8fafc" fontWeight="700">
        Seleccionar alcances
      </text>
      <text x="60" y="86" fontSize="11" fill="#6b7280">
        Marcá los permisos que tu app necesita. Hacé clic en Listo cuando termines.
      </text>
      {/* Filters */}
      <rect x="60" y="106" width="160" height="32" rx="6" fill="#0b1220" stroke="#1f2937" />
      <text x="76" y="126" fontSize="12" fill="#9ca3af">Todas las API ▾</text>
      <rect x="232" y="106" width="508" height="32" rx="6" fill="#0b1220" stroke="#1f2937" />
      <text x="248" y="126" fontSize="12" fill="#475569">🔎  Buscar alcance...</text>
      {/* Header row */}
      <text x="60" y="170" fontSize="11" fill="#6b7280" fontWeight="600">
        Recurso
      </text>
      <text x="320" y="170" fontSize="11" fill="#6b7280" fontWeight="600">
        API
      </text>
      <text x="460" y="170" fontSize="11" fill="#6b7280" fontWeight="600">
        Alcances
      </text>
      <line x1="60" y1="178" x2="740" y2="178" stroke="#1f2937" />
      {/* Rows. We render scope name as a short read/write tag and trust the
          tutorial body to spell out the full scope id. The row layout and
          checkboxes mirror the live picker. */}
      {rows.map((row, i) => {
        const y = 200 + i * 56;
        return (
          <g key={row.resource}>
            <text x="60" y={y + 16} fontSize="12" fill="#e5e7eb" fontWeight="600">
              {row.resource}
            </text>
            <text x="320" y={y + 16} fontSize="11" fill="#9ca3af">
              {row.api}
            </text>
            {row.scopes.map((s, j) => (
              <g key={s}>
                <rect
                  x={460 + j * 142}
                  y={y + 2}
                  width="14"
                  height="14"
                  rx="3"
                  fill="#22d3ee"
                />
                <path
                  d={`M${463 + j * 142} ${y + 9} L${467 + j * 142} ${y + 13} L${472 + j * 142} ${y + 5}`}
                  stroke="#0b1220"
                  strokeWidth="2"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <text
                  x={478 + j * 142}
                  y={y + 14}
                  fontSize="9.5"
                  fill="#22d3ee"
                  fontFamily="monospace"
                  fontWeight="600"
                >
                  {s.startsWith('read_') ? 'read' : 'write'}
                </text>
              </g>
            ))}
            <line x1="60" y1={y + 38} x2="740" y2={y + 38} stroke="#111827" />
          </g>
        );
      })}
      {/* Footer buttons */}
      <rect x="580" y="470" width="80" height="32" rx="6" fill="#1f2937" />
      <text x="620" y="490" fontSize="12" fill="#9ca3af" textAnchor="middle">
        Cancelar
      </text>
      <rect x="668" y="470" width="72" height="32" rx="6" fill="#22d3ee" />
      <text x="704" y="490" fontSize="12" fill="#0b1220" fontWeight="700" textAnchor="middle">
        Listo
      </text>
    </svg>
  );
}

/** Step 8: Configuración tab with the "Mostrar token una vez" reveal. */
export function MockTokenReveal({ className }: MockProps) {
  return (
    <svg
      viewBox="0 0 800 460"
      role="img"
      aria-label="Ilustración: token shpat con botón Mostrar token una vez"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width="800" height="460" rx="10" fill="#0b1220" />
      <rect x="0" y="0" width="800" height="36" rx="10" fill="#111827" />
      <circle cx="20" cy="18" r="5" fill="#ef4444" />
      <circle cx="38" cy="18" r="5" fill="#f59e0b" />
      <circle cx="56" cy="18" r="5" fill="#10b981" />
      <text x="180" y="22" fontSize="11" fill="#6b7280" fontFamily="monospace">
        dev.shopify.com/dashboard/.../apps/.../configuracion
      </text>
      <text x="40" y="76" fontSize="16" fill="#f8fafc" fontWeight="700">
        Token de acceso de Admin API
      </text>
      <text x="40" y="100" fontSize="12" fill="#6b7280">
        Este token solo se muestra una vez. Copialo y guardalo en un lugar seguro.
      </text>
      {/* Token field — masked */}
      <rect
        x="40"
        y="130"
        width="540"
        height="46"
        rx="8"
        fill="#0f172a"
        stroke="#1f2937"
      />
      <text x="56" y="158" fontSize="13" fill="#22d3ee" fontFamily="monospace">
        shpat_••••••••••••••••••••••••••••••••
      </text>
      <rect
        x="600"
        y="130"
        width="160"
        height="46"
        rx="8"
        fill="rgba(34,211,238,0.15)"
        stroke="#22d3ee"
        strokeWidth="2"
      />
      <text
        x="680"
        y="158"
        fontSize="12"
        fill="#22d3ee"
        fontWeight="700"
        textAnchor="middle"
      >
        Mostrar token una vez
      </text>
      <line
        x1="700"
        y1="184"
        x2="700"
        y2="200"
        stroke="#22d3ee"
        strokeWidth="2.5"
      />
      <text x="700" y="220" fontSize="12" fill="#22d3ee" fontWeight="600" textAnchor="middle">
        Hacé clic
      </text>
      {/* Warning panel */}
      <rect
        x="40"
        y="240"
        width="720"
        height="80"
        rx="10"
        fill="rgba(245,158,11,0.08)"
        stroke="#f59e0b"
      />
      <text x="60" y="266" fontSize="13" fill="#fbbf24" fontWeight="700">
        ⚠ Atención
      </text>
      <text x="60" y="290" fontSize="12" fill="#fde68a">
        Shopify NO te muestra este token de nuevo. Si lo perdés, tenés que crear una
      </text>
      <text x="60" y="306" fontSize="12" fill="#fde68a">
        nueva versión de la app y volver a publicarla. Pegalo en LabelFlow ya.
      </text>
    </svg>
  );
}

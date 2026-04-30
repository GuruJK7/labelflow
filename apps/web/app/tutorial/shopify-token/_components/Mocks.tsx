/**
 * Real screenshots of each Shopify Admin / Dev Dashboard screen the user
 * encounters while creating their Admin API token + OAuth-installing the
 * app to obtain a `shpat_*` token.
 *
 * Why screenshots vs. SVG mocks (history):
 *   The first version of this tutorial (2026-04-28) used hand-drawn SVG
 *   illustrations. The operator audited and asked for real captures because
 *   merchants find pixel-accurate screenshots more trustworthy. The captures
 *   in `apps/web/public/tutorial/shopify/` were taken on 2026-04-29 against
 *   the operator's KARBON store, with sensitive data (store name, user
 *   email, addresses, Client ID) redacted via `PIL` before deploy.
 *
 * If Shopify rolls a UI change:
 *   1. Re-take the affected screenshot against a real store.
 *   2. Run the redaction script (see commit history) before placing it in
 *      `public/tutorial/shopify/`.
 *   3. Update the `alt` text in this file if the screen content changed.
 */

type ScreenshotProps = {
  className?: string;
};

function Screenshot({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return (
    <figure className={`overflow-hidden rounded-lg border border-white/[0.08] bg-black/40 ${className ?? ''}`}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        className="block w-full h-auto"
      />
    </figure>
  );
}

/** Step 5: dev.shopify.com/dashboard — empty state for new accounts with
 *  the "Crear app" button top-right and "Crea tu primera app" hero. */
export function Step05DevDashboardEmpty({ className }: ScreenshotProps) {
  return (
    <Screenshot
      src="/tutorial/shopify/05-dev-dashboard-empty.png"
      alt="Captura del Dev Dashboard de Shopify en estado vacío con la card 'Crea tu primera app' y el botón 'Crear app' arriba a la derecha."
      className={className}
    />
  );
}

/** Step 6: dev.shopify.com/.../apps/new — "Crear una app" form showing
 *  two options (Empezar con Shopify CLI vs Empezar desde Dev Dashboard)
 *  with the name "AutoEnvía" filled in. */
export function Step06CreateAppForm({ className }: ScreenshotProps) {
  return (
    <Screenshot
      src="/tutorial/shopify/06-crear-app.png"
      alt="Captura del formulario 'Crear una app' con dos opciones (Shopify CLI a la izquierda, Dev Dashboard a la derecha) y el nombre 'AutoEnvía' tipeado en el campo 'Nombre de la app'."
      className={className}
    />
  );
}

/** Step 7: app overview just after creation — sidebar shows AutoEnvia /
 *  Monitoreo / Registros / Versiones / Configuración, main content shows
 *  the new version form with URL section visible. */
export function Step07VersionFormTop({ className }: ScreenshotProps) {
  return (
    <Screenshot
      src="/tutorial/shopify/07-versiones-top.png"
      alt="Captura del editor de la primera versión de la app, con el sidebar mostrando AutoEnvia / Monitoreo / Registros / Versiones / Configuración."
      className={className}
    />
  );
}

/** Step 8: Acceso section fully filled — 10 scopes pasted as CSV in
 *  "Alcances" + checkbox "Usar flujo de instalación heredado" tildado +
 *  "URLs de redireccionamiento" filled with localhost:3456/callback. */
export function Step08AccessoComplete({ className }: ScreenshotProps) {
  return (
    <Screenshot
      src="/tutorial/shopify/08-acceso-completo.png"
      alt="Captura de la sección 'Acceso' con los 10 alcances en el campo 'Alcances' separados por comas y el checkbox 'Usar flujo de instalación heredado' tildado."
      className={className}
    />
  );
}

/** Step 9 (alternate): scope picker modal — opens when clicking
 *  "Seleccionar alcances", shows the list of all Admin API resources with
 *  checkboxes (read_/write_ pairs). */
export function Step09ScopePicker({ className }: ScreenshotProps) {
  return (
    <Screenshot
      src="/tutorial/shopify/09-scope-picker.png"
      alt="Captura del modal 'Seleccionar alcances' con la lista virtualizada de scopes Admin API (read/write_orders, fulfillments, etc.)."
      className={className}
    />
  );
}

/** Step 10: Publicar button location at the top-right of the version editor. */
export function Step10PublishButton({ className }: ScreenshotProps) {
  return (
    <Screenshot
      src="/tutorial/shopify/10-publicar-button.png"
      alt="Captura de la pantalla 'Crear versión' con el botón 'Publicar' visible arriba a la derecha."
      className={className}
    />
  );
}

/** Step 10b: Publish confirmation modal "¿Publicar esta versión nueva?" */
export function Step10PublishModal({ className }: ScreenshotProps) {
  return (
    <Screenshot
      src="/tutorial/shopify/10b-publicar-modal.png"
      alt="Captura del modal de confirmación '¿Publicar esta versión nueva?' con campos opcionales Nombre y Mensaje, y botones Cancelar/Publicar."
      className={className}
    />
  );
}

/** Step 11: Versions list after publishing — shows v1 with the green
 *  "Activa" badge. */
export function Step11VersionsPublished({ className }: ScreenshotProps) {
  return (
    <Screenshot
      src="/tutorial/shopify/11-versiones-publicada.png"
      alt="Captura de la pestaña 'Versiones' mostrando la versión recién publicada con badge verde 'Activa'."
      className={className}
    />
  );
}

/** Step 12: Configuración tab showing Credenciales section (Client ID +
 *  Secret + Rotar button). Sensitive values are redacted in the published
 *  asset. */
export function Step12CredentialsTab({ className }: ScreenshotProps) {
  return (
    <Screenshot
      src="/tutorial/shopify/12-configuracion-credenciales.png"
      alt="Captura de la pestaña 'Configuración' de la app mostrando la sección 'Credenciales' con campos 'ID de cliente' y 'Secreto' (valores tachados por privacidad)."
      className={className}
    />
  );
}


'use client';

export function PrinterSetup({
  defaultPrinter,
  autoPrintEnabled,
  onSave,
}: {
  defaultPrinter?: string | null;
  autoPrintEnabled?: boolean | null;
  onSave?: (data: Record<string, unknown>) => Promise<void>;
}) {
  return (
    <div className="text-xs text-zinc-500 py-2">
      Configuracion de impresion no disponible todavia.
    </div>
  );
}

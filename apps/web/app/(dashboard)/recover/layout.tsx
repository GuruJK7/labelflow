import { FeatureGate } from '@/components/ui/FeatureGate';
import { requireAdminOrNotFound } from '@/lib/admin';

// Sólo admin (D32): el usuario normal recibe 404 aunque escriba la URL.
export default async function RecoverLayout({ children }: { children: React.ReactNode }) {
  await requireAdminOrNotFound();
  return (
    <FeatureGate
      flag="recover"
      title="WhatsApp Cart Recovery"
      description="Recuperá carritos abandonados automáticamente vía WhatsApp. Enviá mensajes personalizados y aumentá tus ventas."
    >
      {children}
    </FeatureGate>
  );
}

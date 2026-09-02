import { FeatureGate } from '@/components/ui/FeatureGate';

export default function RecoverLayout({ children }: { children: React.ReactNode }) {
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

import { FeatureGate } from '@/components/ui/FeatureGate';

export default function RecoverLayout({ children }: { children: React.ReactNode }) {
  return (
    <FeatureGate
      flag="recover"
      title="WhatsApp Cart Recovery"
      description="Recupera carritos abandonados automaticamente via WhatsApp. Envia mensajes personalizados y aumenta tus ventas."
    >
      {children}
    </FeatureGate>
  );
}

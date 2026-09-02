import { redirect } from 'next/navigation';

export const metadata = {
  title: 'Precios — AutoEnvía',
};

/** La landing ahora tiene su propia sección de precios, así que este alias
 *  legacy deja de tirar a la raíz y cae directo en el tarifario. */
export default function PricingRedirect() {
  redirect('/#precios');
}

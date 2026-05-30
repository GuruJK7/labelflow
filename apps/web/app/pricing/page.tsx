import { redirect } from 'next/navigation';

export const metadata = {
  title: 'LabelFlow Enterprise',
};

export default function PricingRedirect() {
  redirect('/');
}

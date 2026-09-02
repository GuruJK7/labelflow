import { redirect } from 'next/navigation';

export const metadata = {
  title: 'AutoEnvía',
};

export default function HomeRedirect() {
  redirect('/');
}

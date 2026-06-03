/**
 * /cliente/[token] — login-less client portal.
 *
 * Server Component: validates the token in constant time and, only then,
 * loads the allow-listed stores + their labels from the DB and hands them to
 * the interactive client view. A bad token renders the normal 404 (notFound),
 * so the page never even hints that a real portal lives here.
 *
 * force-dynamic: always render per-request (never statically cache a page that
 * serves live, token-gated data). noindex: never let a tokenized URL be
 * indexed by search engines.
 */

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { isValidClientToken, loadClientView } from '@/lib/client-view';
import { ClientPortal } from './ClientPortal';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Etiquetas — Portal de cliente',
  robots: { index: false, follow: false },
};

export default async function ClientViewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  if (!isValidClientToken(token)) {
    notFound();
  }

  const { stores, labels } = await loadClientView();

  return <ClientPortal token={token} stores={stores} labels={labels} />;
}

/**
 * connect-dashboard-tenant.ts
 *
 * Conecta un tenant DEDICADO de LabelFlow con la fuente "AutoEnvía Dashboard"
 * (la página de Santi). Setea dashboardUrl + dashboardToken (encriptado) +
 * dashboardSourceEnabled, y opcionalmente las credenciales DAC y el cron.
 *
 * Requisitos previos:
 *   1. Haber corrido la migración Prisma (las 3 columnas + el enum ya existen).
 *   2. Tener un tenant dedicado (una cuenta/tienda de LabelFlow para Santi).
 *
 * Uso (desde apps/worker/, con el .env del worker que tiene DATABASE_URL + ENCRYPTION_KEY):
 *   TENANT_ID=<id-del-tenant> \
 *   DASHBOARD_TOKEN=ae_xxxxxxxx \
 *   [DASHBOARD_URL=https://autoenvia-dash.vercel.app] \
 *   [DAC_USERNAME=xxxx DAC_PASSWORD=xxxx] \
 *   [CRON="cron de 5 campos, p.ej. cada 15 min"] \
 *   npx ts-node --transpile-only src/connect-dashboard-tenant.ts
 */
import os from 'os';
import path from 'path';
try { require('dotenv').config({ path: path.join(os.homedir(), 'Documents/labelflow/apps/worker/.env') }); } catch { /* noop */ }
try { require('dotenv').config(); } catch { /* noop */ }

import { db } from './db';
import { encryptIfPresent } from './encryption';

async function main(): Promise<void> {
  const tenantId = process.env.TENANT_ID;
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://autoenvia-dash.vercel.app';
  const dashboardToken = process.env.DASHBOARD_TOKEN;
  const dacUsername = process.env.DAC_USERNAME;
  const dacPassword = process.env.DAC_PASSWORD;
  const cron = process.env.CRON;

  if (!tenantId) throw new Error('Falta TENANT_ID (el id del tenant dedicado).');
  if (!dashboardToken) throw new Error('Falta DASHBOARD_TOKEN (el API_TOKEN del dashboard de Santi).');

  const data: Record<string, unknown> = {
    dashboardUrl,
    dashboardToken: encryptIfPresent(dashboardToken),
    dashboardSourceEnabled: true,
  };
  if (dacUsername) data.dacUsername = encryptIfPresent(dacUsername);
  if (dacPassword) data.dacPassword = encryptIfPresent(dacPassword);
  if (cron) data.cronSchedule = cron;

  const t = await db.tenant.update({ where: { id: tenantId }, data });

  // Sanity: el holder de créditos debe estar activo y con saldo > 0, sino el
  // scheduler no encola el job (mismo gate que Shopify).
  console.log('✓ Tenant conectado a la fuente AutoEnvía Dashboard:');
  console.log({
    id: t.id,
    name: t.name,
    dashboardUrl: t.dashboardUrl,
    dashboardSourceEnabled: t.dashboardSourceEnabled,
    dashboardTokenSet: !!t.dashboardToken,
    dacUserSet: !!t.dacUsername,
    cronSchedule: t.cronSchedule,
  });
  console.log('\nRecordatorios:');
  console.log('  • El holder de créditos del tenant debe estar isActive y con saldo > 0.');
  console.log('  • Definí un cronSchedule válido (5 campos) si no lo pasaste, p.ej. */15 * * * *.');
  console.log('  • El worker (Render) tiene que estar deployado con el código nuevo.');
  process.exit(0);
}

main().catch((e) => { console.error('Error:', (e as Error).message); process.exit(1); });

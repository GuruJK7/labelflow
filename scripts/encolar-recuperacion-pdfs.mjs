/**
 * Encola una corrida de RECOVER_PDFS y sigue su progreso.
 *   node _recuperar.mjs <dias> [tope]
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
const db = new PrismaClient();

const DIAS = Number(process.argv[2] ?? 3);
const TOPE = process.argv[3] ? Number(process.argv[3]) : null;
// Se cuelga de la tienda holder sólo porque Job exige un tenantId; la
// recuperación recorre TODAS las tiendas igual.
const TENANT = 'cmn86ab6i0003do10kx8s8cwh'; // Curvadivina

const jobId = randomUUID();
await db.$executeRawUnsafe(
  `INSERT INTO "Job" (id, "tenantId", type, status, trigger, "createdAt")
   VALUES ($1, $2, 'RECOVER_PDFS', 'PENDING', 'MANUAL', NOW())`, jobId, TENANT);
await db.$executeRawUnsafe(
  `INSERT INTO "RunLog" (id, "jobId", "tenantId", level, message, meta, "createdAt")
   VALUES ($1, $2, $3, 'INFO', 'recoverPdfsOpts', $4::jsonb, NOW())`,
  randomUUID(), jobId, TENANT, JSON.stringify({ dias: DIAS, ...(TOPE ? { tope: TOPE } : {}) }));

console.log(`job RECOVER_PDFS encolado: ${jobId} · dias=${DIAS}${TOPE ? ` tope=${TOPE}` : ''}`);

let visto = 0;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const logs = await db.$queryRawUnsafe(
    `select message from "RunLog" where "jobId" = $1 and message like '[recover-pdfs]%' order by "createdAt"`, jobId);
  for (const l of logs.slice(visto)) console.log('   ', l.message.replace('[recover-pdfs] ', ''));
  visto = logs.length;

  const j = await db.$queryRawUnsafe(
    `select status, "totalOrders", "successCount", "failedCount", "skippedCount", "errorMessage"
     from "Job" where id = $1`, jobId);
  if (j[0] && !['PENDING', 'RUNNING'].includes(j[0].status)) {
    console.log('\n=== FIN ===');
    console.log(`estado: ${j[0].status} · candidatas: ${j[0].totalOrders} · recuperadas: ${j[0].successCount} · ya estaban: ${j[0].skippedCount} · fallidas: ${j[0].failedCount}`);
    if (j[0].errorMessage) console.log('mensaje:', j[0].errorMessage);
    await db.$disconnect(); process.exit(0);
  }
}
console.log('sigue corriendo — volvé a consultar');
await db.$disconnect();

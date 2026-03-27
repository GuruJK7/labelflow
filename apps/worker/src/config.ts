import { z } from 'zod';

// Load .env files
try {
  require('dotenv').config({ path: '../../.env' });
  require('dotenv').config();
} catch {
  // dotenv not available, rely on env vars being set externally
}

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  ENCRYPTION_KEY: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().default(2),
  PLAYWRIGHT_HEADLESS: z.string().default('true').transform((v) => v !== 'false'),
  LABELS_TMP_DIR: z.string().default('/tmp/labelflow'),
  CAPTCHA_API_KEY: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('labels'),
});

export type WorkerConfig = z.infer<typeof configSchema>;

let _config: WorkerConfig | null = null;

export function getConfig(): WorkerConfig {
  if (_config) return _config;

  const result = configSchema.safeParse({
    ...process.env,
    SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });

  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`Worker config invalid:\n${errors}`);
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

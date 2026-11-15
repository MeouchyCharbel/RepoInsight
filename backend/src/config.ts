import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load the repository-root .env when present (never committed).
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const schema = z.object({
  MONGO_URL: z.string().startsWith('mongodb://'),
  MONGO_DB: z.string().regex(/^[a-z0-9_]+$/).default('repoinsight'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  COOKIE_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  DEMO_USER_PASSWORD: z.string().min(12).optional(),
  GITHUB_TOKEN: z.string().optional().transform((v) => (v ? v : undefined)),
  OPENSEARCH_URL: z.string().startsWith('https://').default('https://127.0.0.1:9200'),
  OPENSEARCH_APP_USER: z.string().default('ri_app'),
  OPENSEARCH_APP_PASSWORD: z.string().min(8),
  KAFKA_BROKERS: z.string().default('127.0.0.1:9092'),
  KAFKA_APP_USER: z.string().default('ri_app'),
  KAFKA_APP_PASSWORD: z.string().min(8),
  // Local Git clones and fixture repositories (git-ignored).
  DATA_DIR: z.string().default(fileURLToPath(new URL('../../data', import.meta.url))),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Report only the variable names, never their values.
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid or missing environment variables: ${names}`);
  }
  return parsed.data;
}

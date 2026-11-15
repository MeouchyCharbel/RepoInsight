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

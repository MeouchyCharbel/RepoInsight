// Creates .env from .env.example with random secrets. Never overwrites an existing .env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const target = new URL('../.env', import.meta.url);
if (existsSync(target)) {
  console.log('.env already exists - left unchanged.');
  process.exit(0);
}

const rnd = (n = 24) => randomBytes(n).toString('base64url');
const secrets = {
  MONGO_ROOT_PASSWORD: rnd(),
  MONGO_APP_PASSWORD: rnd(),
  MONGO_REPLICA_KEY: randomBytes(48).toString('base64'),
  // OpenSearch demands mixed character classes
  OPENSEARCH_ADMIN_PASSWORD: `Ri-${rnd(18)}9a!`,
  OPENSEARCH_APP_PASSWORD: `Ri-${rnd(18)}7b!`,
  KAFKA_APP_PASSWORD: rnd(),
  DEMO_USER_PASSWORD: rnd(18),
};

let env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
for (const [k, v] of Object.entries(secrets)) {
  env = env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`);
}
env = env.replace(
  /^MONGO_URL=.*$/m,
  `MONGO_URL=mongodb://ri_app:${secrets.MONGO_APP_PASSWORD}@127.0.0.1:27017/repoinsight?authSource=repoinsight&directConnection=true`,
);
writeFileSync(target, env, { mode: 0o600 });
console.log('.env created with random secrets.');

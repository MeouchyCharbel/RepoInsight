// One-off setup with the OpenSearch admin account: creates a least-privilege role and user for
// the application. The admin password is used only here and never by the API or worker.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { searchClient } from './client.js';

const config = loadConfig();
const adminPassword = process.env.OPENSEARCH_ADMIN_PASSWORD;
if (!adminPassword) throw new Error('OPENSEARCH_ADMIN_PASSWORD missing from .env');

// Copy the development root CA out of the container so clients can verify TLS.
mkdirSync(config.DATA_DIR, { recursive: true });
const root = fileURLToPath(new URL('../../../', import.meta.url));
execFileSync('docker', ['compose', 'cp', 'opensearch:/usr/share/opensearch/config/root-ca.pem', join(config.DATA_DIR, 'opensearch-root-ca.pem')], { cwd: root, stdio: 'inherit' });

const admin = searchClient({ url: config.OPENSEARCH_URL, username: 'admin', password: adminPassword, dataDir: config.DATA_DIR });
const api = (method: 'PUT', path: string, body: object) => admin.transport.request({ method, path, body });

await api('PUT', '/_plugins/_security/api/roles/ri_app', {
  cluster_permissions: ['cluster_monitor', 'cluster_composite_ops'],
  index_permissions: [{ index_patterns: ['ri-*'], allowed_actions: ['indices_all'] }],
});
await api('PUT', `/_plugins/_security/api/internalusers/${config.OPENSEARCH_APP_USER}`, {
  password: config.OPENSEARCH_APP_PASSWORD,
  backend_roles: [],
});
await api('PUT', '/_plugins/_security/api/rolesmapping/ri_app', { users: [config.OPENSEARCH_APP_USER] });
console.log(`OpenSearch user "${config.OPENSEARCH_APP_USER}" ready (indices ri-* only).`);

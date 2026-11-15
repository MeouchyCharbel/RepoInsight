import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@opensearch-project/opensearch';

/**
 * OpenSearch over HTTPS with the dev cluster's root CA (copied by `npm run search:setup`).
 * The certificate chain is verified; the hostname check is skipped because the bundled demo
 * certificate is issued to node-0.example.com, not 127.0.0.1 (development only).
 */
export function searchClient(opts: { url: string; username: string; password: string; dataDir: string }): Client {
  const ca = readFileSync(join(opts.dataDir, 'opensearch-root-ca.pem'));
  return new Client({
    node: opts.url,
    auth: { username: opts.username, password: opts.password },
    ssl: { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined },
    requestTimeout: 10_000,
  });
}

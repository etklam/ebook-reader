import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApiConfig } from '../config.ts';

test('proxy trust defaults closed and production supplies a single sanitized IP behind ingress isolation', () => {
  const env = { DATABASE_URL: 'postgres://test:test@localhost/test', DB_TLS: 'disable' };
  assert.equal(loadApiConfig(env).trustProxy, false);
  assert.equal(loadApiConfig({ ...env, TRUST_PROXY: 'true' }).trustProxy, true);
  assert.throws(() => loadApiConfig({ ...env, TRUST_PROXY: 'ture' }));
  const api = readFileSync(new URL('../../../ops/k8s/production/03-api-worker.yaml', import.meta.url), 'utf8');
  assert.match(api, /name: TRUST_PROXY\s+value: "true"/);
  const nginx = readFileSync(new URL('../../../ops/nginx/ebook.conf', import.meta.url), 'utf8');
  assert.ok(!nginx.includes('$proxy_add_x_forwarded_for'));
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  const policies = readFileSync(new URL('../../../ops/k8s/production/06-network-policy.yaml', import.meta.url), 'utf8');
  assert.match(policies, /app.kubernetes.io\/name: traefik/);
  assert.match(policies, /name: ebook-api-from-web/);
  const resources = readFileSync(new URL('../../../ops/k8s/production/kustomization.yaml', import.meta.url), 'utf8');
  assert.ok(resources.includes('06-network-policy.yaml'));
});

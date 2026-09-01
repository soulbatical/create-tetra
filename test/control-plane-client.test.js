import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneClient } from '../src/control-plane-client.js';

test('sends only the project name to the install endpoint', async () => {
  let requestBody;
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({
        access_mode: 'private',
        configured_targets: [{ target: 'local', status: 'planned' }],
        npmrc_mode: 'private-env-placeholder',
        license_configured: true,
        clean_cache_checks: [{ target: 'local', status: 'passed' }],
        issues: [],
        next_actions: [],
      });
    },
  });

  await client.install({
    installGrant: 'opaque-grant',
    projectName: 'horeca-crm',
    targets: ['local'],
    verifyCleanCache: true,
  });

  assert.deepEqual(requestBody.project, { name: 'horeca-crm' });
  assert.equal(JSON.stringify(requestBody).includes('/Users/'), false);
  assert.equal('project_path' in requestBody, false);
});

test('never echoes an unsafe server error code', async () => {
  const reflectedSecret = 'token-secret-with-dashes';
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    fetchImpl: async () => Response.json({ code: reflectedSecret }, { status: 500 }),
  });

  await assert.rejects(
    client.requestAuthorization({ action: 'install', project: { name: 'demo' }, targets: ['local'] }),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.equal(error.message.includes(reflectedSecret), false);
      return true;
    },
  );
});

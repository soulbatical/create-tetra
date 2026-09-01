import assert from 'node:assert/strict';
import test from 'node:test';

import { runCreateTetra } from '../src/cli.js';

const result = {
  access_mode: 'private',
  configured_targets: [{ target: 'local', status: 'configured' }],
  npmrc_mode: 'private-env-placeholder',
  license_configured: true,
  clean_cache_checks: [{ target: 'local', status: 'passed' }],
  issues: [],
  next_actions: [],
};

test('runs browser approval and emits only the frozen secret-safe result', async () => {
  const calls = [];
  let output = '';
  const secretValues = ['device-secret', 'install-secret', 'npm-secret', 'license-secret'];
  const client = {
    async requestAuthorization(input) {
      calls.push(['request', input]);
      return {
        authorizationId: 'auth-public-id',
        deviceCode: secretValues[0],
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://app.tetrasaas.com/install/approve?request=public-id',
        intervalSeconds: 1,
        expiresAt: Date.now() + 60_000,
      };
    },
    async pollAuthorization(deviceCode) {
      calls.push(['poll', deviceCode]);
      return { status: 'approved', installGrant: secretValues[1] };
    },
    async install(input) {
      calls.push(['install', input]);
      return result;
    },
  };
  const opened = [];
  const installed = await runCreateTetra({
    argv: ['horeca-crm'],
    cwd: '/tmp',
    client,
    browser: (url) => opened.push(url),
    write: (text) => { output += text; },
    sleep: async () => {},
  });

  assert.equal(installed.kind, 'installed');
  assert.deepEqual(opened, ['https://app.tetrasaas.com/install/approve?request=public-id']);
  assert.equal(calls[0][1].project.name, 'horeca-crm');
  assert.equal(calls[2][1].installGrant, 'install-secret');
  assert.equal(calls[2][1].projectName, 'horeca-crm');
  assert.equal('projectPath' in calls[2][1], false);
  assert.match(output, /Bevestigingscode: ABCD-EFGH/);
  assert.match(output, /local: configured/);
  for (const secret of secretValues) assert.equal(output.includes(secret), false);
});

test('stops without installing when browser approval is denied', async () => {
  let installCalls = 0;
  const client = {
    async requestAuthorization() {
      return {
        authorizationId: 'auth-id', deviceCode: 'secret', userCode: 'SAFE-CODE',
        verificationUri: 'https://app.tetrasaas.com/install/approve',
        intervalSeconds: 1, expiresAt: Date.now() + 60_000,
      };
    },
    async pollAuthorization() { return { status: 'denied' }; },
    async install() { installCalls += 1; return result; },
  };
  await assert.rejects(
    runCreateTetra({ client, browser: () => {}, write: () => {}, sleep: async () => {} }),
    /browser geweigerd/,
  );
  assert.equal(installCalls, 0);
});

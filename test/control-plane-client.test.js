import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneClient } from '../src/control-plane-client.js';

const claimResponse = {
  license_key: 'licence',
  package_registry: {
    provider: 'gitlab',
    project_id: '85262758',
    username: 'customer',
    token: 'deploy-token-value',
    npm_registry_url: 'https://gitlab.com/api/v4/projects/85262758/packages/npm/',
    auth_host_path: '//gitlab.com/api/v4/projects/85262758/packages/npm/',
    scope: '@soulbatical',
    registry_rule: '@soulbatical:registry=https://gitlab.com/api/v4/projects/85262758/packages/npm/',
    npmrc_template: [
      '@soulbatical:registry=https://gitlab.com/api/v4/projects/85262758/packages/npm/',
      '//gitlab.com/api/v4/projects/85262758/packages/npm/:_authToken=${NPM_TOKEN}',
      'always-auth=true',
    ].join('\n'),
  },
  env: {},
  license_verification: { public_keys_json: '{"keys":[]}' },
};

test('the authorization request carries no local path', async () => {
  let body;
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    approvalOrigin: 'http://127.0.0.1:3042',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({
        authorization_id: 'id',
        device_code: 'device',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://127.0.0.1:3042/install/approve',
        interval_seconds: 1,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    },
  });

  await client.requestAuthorization({ action: 'install', project: { name: 'horeca-crm' }, targets: ['local'] });

  assert.deepEqual(body.project, { name: 'horeca-crm' });
  assert.equal(JSON.stringify(body).includes('/Users/'), false);
  assert.equal('project_path' in body, false);
});

test('the grant is spent as a bearer, never in the request body', async () => {
  let seen;
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init };
      return Response.json(claimResponse);
    },
  });

  const claim = await client.claim('grant-secret');

  assert.match(seen.url, /\/api\/tetra\/onboarding\/claim$/);
  assert.equal(seen.init.headers.authorization, 'Bearer grant-secret');
  assert.equal(seen.init.body.includes('grant-secret'), false);
  assert.equal(claim.registry.token, 'deploy-token-value');
});

test('requests refuse redirects and carry an abort deadline', async () => {
  let init;
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    fetchImpl: async (_url, received) => {
      init = received;
      return Response.json({ status: 'pending' });
    },
  });

  await client.pollAuthorization('device-code');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
});

test('never echoes an unsafe server error code', async () => {
  const reflected = 'token-secret-with-dashes';
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    sleep: async () => {},
    fetchImpl: async () => Response.json({ code: reflected }, { status: 500 }),
  });

  await assert.rejects(client.pollAuthorization('device'), (error) => {
    assert.match(error.message, /HTTP 500/);
    assert.equal(error.message.includes(reflected), false);
    return true;
  });
});

test('a non-JSON error body is never echoed back to the terminal', async () => {
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    sleep: async () => {},
    fetchImpl: async () => new Response('<html>token=leaked-secret</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  });

  await assert.rejects(client.pollAuthorization('device'), (error) => {
    assert.match(error.message, /HTTP 502/);
    assert.equal(error.message.includes('leaked-secret'), false);
    return true;
  });
});

test('a plain-HTTP control plane outside localhost is refused', () => {
  assert.throws(() => createControlPlaneClient({ baseUrl: 'http://evil.example' }), /must use HTTPS/);
});

test('a transient 500 is retried and the next attempt is used', async () => {
  let calls = 0;
  const sleeps = [];
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: 'request_failed' }, { status: 500 });
      return Response.json({ status: 'pending' });
    },
  });

  const status = await client.pollAuthorization('device');
  assert.deepEqual(status, { status: 'pending' });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [300]);
});

test('a 429 is retried the same way as a 500', async () => {
  let calls = 0;
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: 'request_failed' }, { status: 429 });
      return Response.json({ status: 'pending' });
    },
  });

  await client.pollAuthorization('device');
  assert.equal(calls, 2);
});

test('retries stop once the attempt budget is spent, and back off exponentially', async () => {
  let calls = 0;
  const sleeps = [];
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    sleep: async (ms) => { sleeps.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ error: 'request_failed' }, { status: 500 });
    },
  });

  await assert.rejects(client.pollAuthorization('device'), /HTTP 500/);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [300, 600]);
});

test('a non-retryable 400 fails on the first attempt', async () => {
  let calls = 0;
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    sleep: async () => { throw new Error('must not sleep for a 400'); },
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ error: 'request_failed' }, { status: 400 });
    },
  });

  await assert.rejects(client.pollAuthorization('device'), /HTTP 400/);
  assert.equal(calls, 1);
});

// A network failure never reached the server, so it carries the same retry
// question as a 5xx for a call that is safe to repeat.
test('a thrown network error is retried on a retryable call', async () => {
  let calls = 0;
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return Response.json({ status: 'pending' });
    },
  });

  const status = await client.pollAuthorization('device');
  assert.deepEqual(status, { status: 'pending' });
  assert.equal(calls, 2);
});

// The grant is spent exactly once. A claim is sent as a bearer and its
// result is never logged — and it must never be sent a second time just
// because the first response (success or failure) did not come back cleanly,
// since the control plane may have already spent it.
test('a 500 on claim is never retried — a grant must not be spent twice', async () => {
  let calls = 0;
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    sleep: async () => { throw new Error('must not sleep when claim is not retryable'); },
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ error: 'request_failed' }, { status: 500 });
    },
  });

  await assert.rejects(client.claim('grant-secret'), /HTTP 500/);
  assert.equal(calls, 1);
});

test('a dropped connection on claim is never retried either', async () => {
  let calls = 0;
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    sleep: async () => { throw new Error('must not sleep when claim is not retryable'); },
    fetchImpl: async () => {
      calls += 1;
      throw new Error('ECONNRESET');
    },
  });

  await assert.rejects(client.claim('grant-secret'), /ECONNRESET/);
  assert.equal(calls, 1);
});

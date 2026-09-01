import assert from 'node:assert/strict';
import test from 'node:test';

import { isReservedRelease } from '../src/cli.js';
import { createControlPlaneClient } from '../src/control-plane-client.js';
import { summarizeInstallResult, validateInstallResult } from '../src/contracts.js';
import { openBrowser } from '../src/open-browser.js';

const base = {
  access_mode: 'private',
  configured_targets: [],
  npmrc_mode: 'private-env-placeholder',
  license_configured: true,
  clean_cache_checks: [],
  issues: [],
  next_actions: [],
};

// Written as code points on purpose. Pasted literally these characters are
// invisible in an editor, a diff and a review — which is the whole reason a
// control plane must not be able to put them in text we print to a terminal.
const HIDDEN_CODE_POINTS = {
  'C1 NEL, which a C0-only check lets through': 0x85,
  'C1 CSI, the start of an ANSI escape sequence': 0x9b,
  'LEFT-TO-RIGHT MARK': 0x200e,
  'RIGHT-TO-LEFT OVERRIDE, which reverses what the terminal shows': 0x202e,
  'LEFT-TO-RIGHT ISOLATE': 0x2066,
};

test('a result with no targets at all is planned, never completed', () => {
  assert.equal(summarizeInstallResult({ ...base, configured_targets: [] }), 'planned');
});

test('the public npmrc mode is accepted by the frozen contract', () => {
  const result = validateInstallResult({ ...base, access_mode: 'public', npmrc_mode: 'public-engine-strict' });
  assert.equal(result.npmrc_mode, 'public-engine-strict');
});

test('control and invisible format characters cannot be smuggled into displayed guidance', () => {
  for (const [name, codePoint] of Object.entries(HIDDEN_CODE_POINTS)) {
    const description = `safe${String.fromCodePoint(codePoint)}text`;
    assert.throws(
      () => validateInstallResult({ ...base, next_actions: [{ code: 'retry', description }] }),
      /invalid next-action description/,
      `expected ${name} to be rejected`,
    );
  }
  assert.doesNotThrow(() => validateInstallResult({
    ...base,
    next_actions: [{ code: 'retry', description: 'Zet de licentie in Doppler, daarna opnieuw proberen.' }],
  }));
});

test('build metadata is not mistaken for a prerelease', () => {
  assert.equal(isReservedRelease('1.0.0+build-foo'), false);
  assert.equal(isReservedRelease('0.0.1-reserved.1'), true);
  assert.equal(isReservedRelease('1.0.0-rc.1+build-foo'), true);
  assert.equal(isReservedRelease('1.0.0'), false);
});

test('the browser is only opened for the allowlisted approval origin', () => {
  for (const url of [
    'http://app.tetrasaas.com/install',
    'https://app.tetrasaas.com.evil.example/install',
    'https://evil.example/install',
  ]) {
    assert.throws(
      () => openBrowser(url, { platform: 'darwin', spawnImpl: () => { throw new Error('spawned'); } }),
      /untrusted/,
      `expected ${url} to be refused`,
    );
  }
});

test('the browser command carries the url as an argument, never through a shell', () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() {} };
  };
  const url = 'https://app.tetrasaas.com/install/approve?request=abc';

  openBrowser(url, { platform: 'darwin', spawnImpl });
  openBrowser(url, { platform: 'win32', spawnImpl });
  openBrowser(url, { platform: 'linux', spawnImpl });

  assert.deepEqual(calls.map(({ command }) => command), ['open', 'cmd', 'xdg-open']);
  assert.deepEqual(calls[1].args, ['/c', 'start', '', url]);
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.ok(call.args.includes(url));
  }
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

test('a non-JSON error body is never echoed back to the terminal', async () => {
  const client = createControlPlaneClient({
    baseUrl: 'http://127.0.0.1:3042',
    fetchImpl: async () => new Response('<html>token=leaked-secret</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  });

  await assert.rejects(client.pollAuthorization('device-code'), (error) => {
    assert.match(error.message, /HTTP 502/);
    assert.equal(error.message.includes('leaked-secret'), false);
    return true;
  });
});

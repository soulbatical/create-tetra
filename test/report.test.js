import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { formatInstallResult, summarizeInstallResult } from '../src/contracts.js';
import { VERSION } from '../src/cli.js';

const base = {
  access_mode: 'private',
  configured_targets: [],
  npmrc_mode: 'private-env-placeholder',
  license_configured: true,
  clean_cache_checks: [],
  issues: [],
  next_actions: [],
};

test('a result where nothing was applied never claims the install finished', () => {
  const planned = { ...base, configured_targets: [{ target: 'local', status: 'planned' }] };
  assert.equal(summarizeInstallResult(planned), 'planned');
  const output = formatInstallResult(planned);
  assert.doesNotMatch(output, /installatie afgerond/);
  assert.match(output, /nog niets geinstalleerd/);
});

test('a failed target or an unrecoverable issue reports failure', () => {
  assert.equal(
    summarizeInstallResult({ ...base, configured_targets: [{ target: 'local', status: 'failed' }] }),
    'failed',
  );
  assert.equal(
    summarizeInstallResult({
      ...base,
      configured_targets: [{ target: 'local', status: 'configured' }],
      issues: [{ code: 'license_missing', summary: 'Geen licentie.', recoverable: false }],
    }),
    'failed',
  );
});

test('a partially configured result is not reported as completed', () => {
  assert.equal(
    summarizeInstallResult({
      ...base,
      configured_targets: [
        { target: 'local', status: 'configured' },
        { target: 'netlify-preview', status: 'skipped' },
      ],
    }),
    'partial',
  );
});

test('only a fully applied result without issues is completed', () => {
  const done = { ...base, configured_targets: [{ target: 'local', status: 'configured' }] };
  assert.equal(summarizeInstallResult(done), 'completed');
  assert.match(formatInstallResult(done), /Tetra-installatie afgerond\./);
});

test('issues and next actions are shown, not just counted', () => {
  const output = formatInstallResult({
    ...base,
    configured_targets: [{ target: 'local', status: 'planned' }],
    issues: [{ code: 'license_missing', target: 'local', summary: 'Licentie ontbreekt.', recoverable: true }],
    next_actions: [{ code: 'set_license', description: 'Zet TETRA_LICENSE_KEY.' }],
  });
  assert.match(output, /\[local\/license_missing\] Licentie ontbreekt\./);
  assert.match(output, /\[set_license\] Zet TETRA_LICENSE_KEY\./);
});

test('the reported version follows package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('a reserved prerelease refuses to run and touches no control plane', async () => {
  const { runCreateTetra, isReservedRelease } = await import('../src/cli.js');
  assert.equal(isReservedRelease('0.0.1-reserved.1'), true);
  assert.equal(isReservedRelease('0.1.0'), false);

  let output = '';
  const run = await runCreateTetra({
    argv: [],
    version: '0.0.1-reserved.1',
    client: { requestAuthorization() { throw new Error('must not reach the control plane'); } },
    browser: () => { throw new Error('must not open a browser'); },
    write: (text) => { output += text; },
  });
  assert.equal(run.kind, 'unavailable');
  assert.match(output, /nog niet beschikbaar/);
});

test('the published claim version is a prerelease', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

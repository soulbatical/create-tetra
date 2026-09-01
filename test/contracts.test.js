import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAuthorization, validateAuthorizationStatus, validateInstallResult } from '../src/contracts.js';

test('refuses a browser approval URL outside app.tetrasaas.com', () => {
  assert.throws(() => validateAuthorization({
    authorization_id: 'id', device_code: 'secret', user_code: 'CODE',
    verification_uri: 'https://lookalike.example/install',
    interval_seconds: 2, expires_at: new Date(Date.now() + 60_000).toISOString(),
  }), /untrusted/);
});

test('refuses extra fields in the frozen install result', () => {
  assert.throws(() => validateInstallResult({
    access_mode: 'private', configured_targets: [], npmrc_mode: 'private-env-placeholder',
    license_configured: true, clean_cache_checks: [], issues: [], next_actions: [],
    npm_token: 'must-never-cross-this-contract',
  }), /outside the frozen contract/);
});

test('refuses extra or terminal-control fields in nested guidance', () => {
  const base = {
    access_mode: 'private', configured_targets: [], npmrc_mode: 'private-env-placeholder',
    license_configured: true, clean_cache_checks: [], issues: [], next_actions: [],
  };
  assert.throws(() => validateInstallResult({
    ...base,
    issues: [{ code: 'failed', summary: 'safe', recoverable: false, token: 'secret' }],
  }), /outside the frozen contract/);
  assert.throws(() => validateInstallResult({
    ...base,
    next_actions: [{ code: 'retry', description: 'safe\nsecret' }],
  }), /invalid next-action description/);
});

test('refuses server extensions to authorization status and excessive expiry', () => {
  assert.throws(() => validateAuthorizationStatus({ status: 'pending', token: 'secret' }), /outside the frozen contract/);
  assert.throws(() => validateAuthorization({
    authorization_id: 'id', device_code: 'secret', user_code: 'SAFE-CODE',
    verification_uri: 'https://app.tetrasaas.com/install/approve',
    interval_seconds: 2, expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  }), /expired authorization/);
});

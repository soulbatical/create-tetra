import assert from 'node:assert/strict';
import test from 'node:test';

import { isReservedRelease } from '../src/cli.js';
import { validateAuthorization, validateAuthorizationStatus } from '../src/contracts.js';

const ORIGIN = 'https://tetrasaas.com';

const authorization = (overrides = {}) => ({
  authorization_id: 'auth-id',
  device_code: 'device-secret',
  user_code: 'ABCD-EFGH',
  verification_uri: `${ORIGIN}/install/approve`,
  interval_seconds: 2,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

test('accepts an authorization on the approval origin', () => {
  const result = validateAuthorization(authorization(), { approvalOrigin: ORIGIN });
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal(result.intervalSeconds, 2);
});

test('refuses an approval URL outside the allowlisted origin', () => {
  for (const uri of [
    'https://lookalike.example/install',
    'https://tetrasaas.com.evil.example/install',
    'http://tetrasaas.com/install',
    'https://www.tetrasaas.com/install',
  ]) {
    assert.throws(
      () => validateAuthorization(authorization({ verification_uri: uri }), { approvalOrigin: ORIGIN }),
      /untrusted/,
      `expected ${uri} to be refused`,
    );
  }
});

// A long-lived authorization is a long-lived window for someone to phish an
// approval, so the CLI caps what it will accept rather than trusting the server.
test('refuses an expiry that is in the past or unreasonably far ahead', () => {
  for (const expiresAt of [
    new Date(Date.now() - 1_000).toISOString(),
    new Date(Date.now() + 60 * 60_000).toISOString(),
    'not-a-date',
  ]) {
    assert.throws(
      () => validateAuthorization(authorization({ expires_at: expiresAt }), { approvalOrigin: ORIGIN }),
      /expired authorization/,
      `expected expiry ${expiresAt} to be refused`,
    );
  }
});

test('refuses a polling interval outside the accepted range', () => {
  for (const interval of [0, -1, 31, 1.5, 'fast']) {
    assert.throws(
      () => validateAuthorization(authorization({ interval_seconds: interval }), { approvalOrigin: ORIGIN }),
      /invalid polling interval/,
      `expected interval ${interval} to be refused`,
    );
  }
});

test('refuses a user code the customer could not compare', () => {
  for (const code of ['abcd-efgh', 'AB', 'ABCD EFGH', 'ABCD-EFGH-IJKL']) {
    assert.throws(
      () => validateAuthorization(authorization({ user_code: code }), { approvalOrigin: ORIGIN }),
      /invalid user code/,
      `expected user code ${code} to be refused`,
    );
  }
});

test('refuses extra or missing fields on the authorization', () => {
  const extra = { ...authorization(), install_grant: 'too-early' };
  assert.throws(() => validateAuthorization(extra, { approvalOrigin: ORIGIN }), /outside the frozen contract/);

  const missing = authorization();
  delete missing.device_code;
  assert.throws(() => validateAuthorization(missing, { approvalOrigin: ORIGIN }), /outside the frozen contract/);
});

test('refuses server extensions to the authorization status', () => {
  assert.throws(() => validateAuthorizationStatus({ status: 'pending', token: 'secret' }), /outside the frozen contract/);
  assert.throws(() => validateAuthorizationStatus({ status: 'approved' }), /outside the frozen contract/);
  assert.throws(() => validateAuthorizationStatus({ status: 'whatever' }), /unknown authorization status/);

  assert.deepEqual(validateAuthorizationStatus({ status: 'denied' }), { status: 'denied' });
  assert.deepEqual(
    validateAuthorizationStatus({ status: 'approved', install_grant: 'grant' }),
    { status: 'approved', installGrant: 'grant' },
  );
});

// npm can attach `latest` to the first version of a brand-new package whatever
// dist-tag we publish under, so this predicate is the only thing standing between
// a reserved claim and someone running it.
test('a prerelease is reserved and a real release is not', () => {
  for (const version of ['0.0.1-reserved.1', '1.0.0-rc.1', '1.0.0-rc.1+build-foo', '2.0.0-0']) {
    assert.equal(isReservedRelease(version), true, `${version} must count as reserved`);
  }
  for (const version of ['1.0.0', '0.1.0', '1.0.0+build-foo', '10.20.30']) {
    assert.equal(isReservedRelease(version), false, `${version} must count as a real release`);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { renderProjectFiles, validateClaim } from '../src/claim.js';

const payload = () => ({
  license_key: 'eyJhbGciOiJFZERTQSJ9.licence',
  package_registry: {
    provider: 'gitlab',
    project_id: '85262758',
    username: 'tetra-customer',
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
  license_verification: { mode: 'offline_ed25519', public_keys_json: '{"keys":[]}' },
});

test('accepts the onboarding claim the control plane issues', () => {
  const claim = validateClaim(payload());
  assert.equal(claim.registry.provider, 'gitlab');
  assert.equal(claim.registry.scope, '@soulbatical');
  assert.equal(claim.licenseKey, 'eyJhbGciOiJFZERTQSJ9.licence');
});

test('refuses an npmrc template that points anywhere we did not ask for', () => {
  for (const extra of [
    'registry=https://evil.example/',
    'script-shell=/bin/sh',
    '//evil.example/:_authToken=stolen',
    '@other:registry=https://evil.example/',
  ]) {
    const value = payload();
    value.package_registry.npmrc_template += `\n${extra}`;
    assert.throws(
      () => validateClaim(value),
      /unexpected directive/,
      `expected ${extra} to be refused`,
    );
  }
});

test('refuses a registry URL that is not HTTPS', () => {
  const value = payload();
  value.package_registry.npm_registry_url = 'http://gitlab.com/api/v4/projects/85262758/packages/npm/';
  assert.throws(() => validateClaim(value), /non-HTTPS/);
});

test('refuses a claim that is missing part of the registry contract', () => {
  const value = payload();
  delete value.package_registry.token;
  assert.throws(() => validateClaim(value), /omitted package_registry\.token/);
});

test('refuses an npmrc template without a token placeholder', () => {
  const value = payload();
  value.package_registry.npmrc_template = value.package_registry.registry_rule;
  assert.throws(() => validateClaim(value), /without a token placeholder/);
});

test('the token goes into .env, never into .npmrc', () => {
  const claim = validateClaim(payload());
  const { npmrc, env } = renderProjectFiles(claim);

  assert.equal(npmrc.includes('deploy-token-value'), false);
  assert.match(npmrc, /@soulbatical:registry=/);
  assert.match(npmrc, /:_authToken=\$\{NPM_TOKEN\}/);
  assert.match(npmrc, /engine-strict=true/);

  assert.match(env, /^NPM_TOKEN=deploy-token-value$/m);
  assert.match(env, /^TETRA_LICENSE_KEY=eyJhbGciOiJFZERTQSJ9\.licence$/m);
  assert.match(env, /^TETRA_LICENSE_PUBLIC_KEYS_JSON=\{"keys":\[\]\}$/m);
});

test('the customer never needs the org-wide token or Doppler', () => {
  const { npmrc, env } = renderProjectFiles(validateClaim(payload()));
  for (const forbidden of ['npm.pkg.github.com', 'doppler', 'shared/prd']) {
    assert.equal(npmrc.toLowerCase().includes(forbidden), false, `${forbidden} in .npmrc`);
    assert.equal(env.toLowerCase().includes(forbidden), false, `${forbidden} in .env`);
  }
});

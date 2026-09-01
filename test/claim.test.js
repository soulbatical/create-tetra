import assert from 'node:assert/strict';
import test from 'node:test';

import { renderProjectFiles, validateClaim } from '../src/claim.js';

const REGISTRY = 'https://gitlab.com/api/v4/projects/85262758/packages/npm/';
const AUTH_LINE = '//gitlab.com/api/v4/projects/85262758/packages/npm/:_authToken=${NPM_TOKEN}';

const payload = () => ({
  license_key: 'eyJhbGciOiJFZERTQSJ9.licence',
  package_registry: {
    provider: 'gitlab',
    project_id: '85262758',
    username: 'tetra-customer',
    token: 'deploy-token-value',
    npm_registry_url: REGISTRY,
    auth_host_path: '//gitlab.com/api/v4/projects/85262758/packages/npm/',
    scope: '@soulbatical',
    registry_rule: `@soulbatical:registry=${REGISTRY}`,
    npmrc_template: [`@soulbatical:registry=${REGISTRY}`, AUTH_LINE, 'always-auth=true'].join('\n'),
  },
  env: {},
  license_verification: { mode: 'offline_ed25519', public_keys_json: '{"keys":[]}' },
});

const withTemplate = (lines) => {
  const value = payload();
  value.package_registry.npmrc_template = lines.join('\n');
  return value;
};

test('accepts the onboarding claim the control plane issues', () => {
  const claim = validateClaim(payload());
  assert.equal(claim.registry.provider, 'gitlab');
  assert.equal(claim.registry.url, REGISTRY);
  assert.equal(claim.licenseKey, 'eyJhbGciOiJFZERTQSJ9.licence');
});

// The whole security promise of this package is that a control plane cannot make
// us install from somewhere else. Checking only the start of the line does not
// deliver that: everything after the '=' decides where npm actually goes.
test('refuses a registry line that merely starts correctly', () => {
  for (const declared of [
    'http://evil.example/npm/',
    'https://evil.example/npm/',
    'https://gitlab.com.evil.example/api/v4/projects/85262758/packages/npm/',
    `${REGISTRY}../../../other/packages/npm/`,
    'not-a-url',
  ]) {
    assert.throws(
      () => validateClaim(withTemplate([`@soulbatical:registry=${declared}`, AUTH_LINE])),
      /different registry|invalid registry URL/,
      `expected registry=${declared} to be refused`,
    );
  }
});

test('refuses a token line for any host other than the validated registry', () => {
  for (const auth of [
    '//evil.example/:_authToken=${NPM_TOKEN}',
    '//gitlab.com/:_authToken=${NPM_TOKEN}',
    '//gitlab.com/api/v4/projects/1/packages/npm/:_authToken=${NPM_TOKEN}',
    '//gitlab.com/api/v4/projects/85262758/packages/npm/:_authToken=stolen-literal',
  ]) {
    assert.throws(
      () => validateClaim(withTemplate([`@soulbatical:registry=${REGISTRY}`, auth])),
      /authenticating a different host/,
      `expected ${auth} to be refused`,
    );
  }
});

test('refuses more than one registry or token line', () => {
  assert.throws(
    () => validateClaim(withTemplate([
      `@soulbatical:registry=${REGISTRY}`,
      `@soulbatical:registry=${REGISTRY}`,
      AUTH_LINE,
    ])),
    /exactly one registry line/,
  );
  assert.throws(
    () => validateClaim(withTemplate([`@soulbatical:registry=${REGISTRY}`, AUTH_LINE, AUTH_LINE])),
    /exactly one token line/,
  );
  assert.throws(
    () => validateClaim(withTemplate([AUTH_LINE])),
    /exactly one registry line/,
  );
  assert.throws(
    () => validateClaim(withTemplate([`@soulbatical:registry=${REGISTRY}`])),
    /exactly one token line/,
  );
});

test('refuses any npm directive we did not ask for', () => {
  for (const extra of ['script-shell=/bin/sh', 'registry=https://evil.example/', 'ignore-scripts=false']) {
    assert.throws(
      () => validateClaim(withTemplate([`@soulbatical:registry=${REGISTRY}`, AUTH_LINE, extra])),
      /unexpected directive/,
      `expected ${extra} to be refused`,
    );
  }
});

// npm's ini parser treats a bare \r as a line break; a check that only splits on
// \n would never see what comes after it.
test('refuses a carriage return smuggled into the template', () => {
  const smuggled = `@soulbatical:registry=${REGISTRY}\r registry=https://evil.example/`;
  assert.throws(() => validateClaim(withTemplate([smuggled, AUTH_LINE])), /control characters/);
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

// Every one of these becomes a KEY=value line in .env. A newline in the value
// defines extra environment variables in the customer's project.
test('refuses a newline in any value that becomes an env line', () => {
  const injections = {
    license_key: 'good-key\nNODE_OPTIONS=--require /tmp/evil.js',
    token: 'good-token\nSUPABASE_SERVICE_ROLE_KEY=stolen',
  };
  for (const [field, injected] of Object.entries(injections)) {
    const value = payload();
    if (field === 'license_key') value.license_key = injected;
    else value.package_registry[field] = injected;
    assert.throws(
      () => validateClaim(value),
      /control characters/,
      `expected an injected ${field} to be refused`,
    );
  }

  const keys = payload();
  keys.license_verification.public_keys_json = '{"keys":[]}\nNPM_TOKEN=stolen';
  assert.throws(() => validateClaim(keys), /control characters/);
});

test('an injected env line cannot reach the rendered .env', () => {
  const value = payload();
  value.license_key = 'good-key\nNODE_OPTIONS=--require /tmp/evil.js';
  assert.throws(() => renderProjectFiles(validateClaim(value)));

  const { env } = renderProjectFiles(validateClaim(payload()));
  assert.equal(env.split('\n').filter((line) => line.includes('=')).length, 3);
  assert.equal(env.includes('NODE_OPTIONS'), false);
});

test('the token goes into .env, never into .npmrc', () => {
  const { npmrc, env } = renderProjectFiles(validateClaim(payload()));

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

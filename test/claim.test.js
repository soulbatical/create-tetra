import assert from 'node:assert/strict';
import test from 'node:test';

import { SCAFFOLDER_SCOPE, renderProjectFiles, validateClaim } from '../src/claim.js';
import { SCAFFOLDER } from '../src/scaffold.js';

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

// NPM_TOKEN in .env is dead weight on its own: npm reads npm_config_* and its
// npmrc files, never .env, and the project npmrc deliberately carries no
// _authToken line. A customer who wires the variable into CI and expects it to
// work gets a 401 with nothing pointing at the cause, so .env has to say which
// line makes it do something.
test('the CI token in .env comes with the npmrc line that makes it work', () => {
  const { env } = renderProjectFiles(validateClaim(payload()));

  assert.match(env, /NPM_TOKEN=deploy-token-value/);
  assert.ok(
    env.includes('//gitlab.com/api/v4/projects/85262758/packages/npm/:_authToken=${NPM_TOKEN}'),
    `the exact npmrc line has to be there to copy, got:\n${env}`,
  );
  // Instructions only: it must stay a comment, or a .env parser would hand the
  // literal placeholder to something as if it were the token.
  for (const line of env.split('\n')) {
    if (line.includes('${NPM_TOKEN}')) assert.match(line, /^#/, 'the example line must be commented out');
  }
});

test('the project config carries no secret and no placeholder npm would send literally', () => {
  const { projectNpmrc, userNpmrcEntry, env } = renderProjectFiles(validateClaim(payload()));

  // npm does not read .env, so a ${NPM_TOKEN} placeholder in the project config
  // is sent to the registry verbatim and the customer gets a bare 401.
  assert.equal(projectNpmrc.includes('deploy-token-value'), false);
  assert.equal(projectNpmrc.includes('${NPM_TOKEN}'), false);
  assert.equal(projectNpmrc.includes('_authToken'), false);
  assert.match(projectNpmrc, /@soulbatical:registry=/);
  assert.match(projectNpmrc, /engine-strict=true/);

  // The credential goes where npm actually looks for it.
  assert.equal(
    userNpmrcEntry,
    '//gitlab.com/api/v4/projects/85262758/packages/npm/:_authToken=deploy-token-value',
  );

  assert.match(env, /^TETRA_LICENSE_KEY=eyJhbGciOiJFZERTQSJ9\.licence$/m);
  assert.match(env, /^TETRA_LICENSE_PUBLIC_KEYS_JSON=\{"keys":\[\]\}$/m);
});

test('an injected env line cannot reach the rendered .env', () => {
  const value = payload();
  value.license_key = 'good-key\nNODE_OPTIONS=--require /tmp/evil.js';
  assert.throws(() => validateClaim(value), /control characters/);

  const { env } = renderProjectFiles(validateClaim(payload()));
  assert.equal(env.includes('NODE_OPTIONS'), false);
});

test('the customer never needs the org-wide token or Doppler', () => {
  const { projectNpmrc, env } = renderProjectFiles(validateClaim(payload()));
  for (const forbidden of ['npm.pkg.github.com', 'doppler', 'shared/prd']) {
    assert.equal(projectNpmrc.toLowerCase().includes(forbidden), false);
    assert.equal(env.toLowerCase().includes(forbidden), false);
  }
});

// A credential in the URL would be written into the file the customer commits,
// which is exactly what splitting project and user config is meant to prevent.
test('refuses a registry URL carrying credentials', () => {
  for (const url of [
    'https://deploy:s3cr3t@gitlab.com/api/v4/projects/85262758/packages/npm/',
    'https://deploy@gitlab.com/api/v4/projects/85262758/packages/npm/',
  ]) {
    const value = payload();
    value.package_registry.npm_registry_url = url;
    assert.throws(() => validateClaim(value), /containing credentials/, `expected ${url} to be refused`);
  }
});

// The scaffolder is our own infrastructure, so the set of hosts it can live on
// is short and known. Consistency between the fields is not enough: a control
// plane that sets both to the same attacker host would otherwise pass.
test('refuses a registry on a host we do not ship from', () => {
  const value = payload();
  value.package_registry.npm_registry_url = 'https://evil.example/npm/';
  value.package_registry.npmrc_template = [
    '@soulbatical:registry=https://evil.example/npm/',
    '//evil.example/npm/:_authToken=${NPM_TOKEN}',
  ].join('\n');
  assert.throws(() => validateClaim(value), /unexpected host/);
});

test('accepts every host we actually ship from', () => {
  for (const [host, path] of [
    ['gitlab.com', '/api/v4/projects/85262758/packages/npm/'],
    ['npm.pkg.github.com', '/'],
    ['registry.tetrasaas.com', '/'],
  ]) {
    const url = `https://${host}${path}`;
    const value = payload();
    value.package_registry.npm_registry_url = url;
    value.package_registry.npmrc_template = [
      `@soulbatical:registry=${url}`,
      `//${host}${path}:_authToken=\${NPM_TOKEN}`,
    ].join('\n');
    assert.doesNotThrow(() => validateClaim(value), `expected ${host} to be accepted`);
  }
});

// The project install runs the customer's real project and therefore runs
// lifecycle scripts. A registry a caller did not explicitly allow is code
// execution, and localhost is not special in that respect.
test('a local registry is refused unless a caller explicitly allows it', () => {
  for (const url of ['http://localhost:4873/npm/', 'http://127.0.0.1:4873/npm/', 'https://localhost/npm/']) {
    const value = payload();
    value.package_registry.npm_registry_url = url;
    value.package_registry.npmrc_template = [
      `@soulbatical:registry=${url}`,
      `//${new URL(url).host}/npm/:_authToken=\${NPM_TOKEN}`,
    ].join('\n');
    assert.throws(
      () => validateClaim(value),
      /non-HTTPS|unexpected host/,
      `expected ${url} to be refused in production`,
    );
  }
});

// npm prefers the trailing-slash form when two entries exist for one registry,
// so a stale entry of the customer's would outrank a slashless key we wrote.
test('a registry without a trailing slash is canonicalised before anything is derived', () => {
  const url = 'https://gitlab.com/api/v4/projects/85262758/packages/npm';
  const value = payload();
  value.package_registry.npm_registry_url = url;
  value.package_registry.npmrc_template = [
    `@soulbatical:registry=${url}`,
    `//gitlab.com/api/v4/projects/85262758/packages/npm:_authToken=\${NPM_TOKEN}`,
  ].join('\n');

  const claim = validateClaim(value);
  assert.equal(claim.registry.url, 'https://gitlab.com/api/v4/projects/85262758/packages/npm/');
  assert.equal(claim.registry.authKey, '//gitlab.com/api/v4/projects/85262758/packages/npm/');

  const { projectNpmrc, userNpmrcEntry } = renderProjectFiles(claim);
  assert.match(projectNpmrc, /packages\/npm\/$/m);
  assert.match(userNpmrcEntry, /packages\/npm\/:_authToken=/);
});

// npm appends the package path to the registry, so a query string lands in the
// middle of the request URI, matches no auth key, and yields an opaque 404.
test('refuses a registry URL with a query string or fragment', () => {
  for (const url of [
    'https://gitlab.com/api/v4/projects/85262758/packages/npm/?token=1',
    'https://gitlab.com/api/v4/projects/85262758/packages/npm/#frag',
  ]) {
    const value = payload();
    value.package_registry.npm_registry_url = url;
    assert.throws(() => validateClaim(value), /query or fragment/, `expected ${url} to be refused`);
  }
});

// The registry mapping we write is scoped, but the package we install is a
// literal. If those two scopes ever differ, `@soulbatical/create-app` resolves
// against the public registry instead — dependency confusion, from a claim that
// otherwise passed every other check.
test('a claim that maps a scope other than the scaffolder\'s is refused', () => {
  const other = '@notsoulbatical';
  assert.throws(
    () => validateClaim({
      ...payload(),
      package_registry: {
        ...payload().package_registry,
        scope: other,
        registry_rule: `${other}:registry=${REGISTRY}`,
        npmrc_template: [`${other}:registry=${REGISTRY}`, AUTH_LINE, 'always-auth=true'].join('\n'),
      },
    }),
    /scope/i,
  );
});

test('the pinned scope and the package we install cannot drift apart', () => {
  assert.equal(
    SCAFFOLDER.startsWith(`${SCAFFOLDER_SCOPE}/`),
    true,
    `${SCAFFOLDER} does not live in the pinned scope ${SCAFFOLDER_SCOPE}`,
  );
});

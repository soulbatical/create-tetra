// The onboarding claim is the one response that legitimately carries credentials:
// a per-customer read-only registry token and a runtime licence key. It is fetched
// over a one-time bearer grant and never printed.
//
// What this validation does and does not do, precisely, because the difference
// matters: it pins the registry to a host we control, requires HTTPS, and then
// enforces that every line we write into the customer's npm config refers to that
// same registry and nothing else. It cannot tell you whether Soulbatical's own
// control plane has been compromised — it can only stop that control plane from
// redirecting a customer's install to a third party.

const REGISTRY_KEYS = [
  'provider',
  'project_id',
  'username',
  'token',
  'npm_registry_url',
  'auth_host_path',
  'scope',
  'registry_rule',
  'npmrc_template',
];

// The scaffolder is Soulbatical infrastructure, not customer-supplied, so the
// set of hosts it can ever live on is short and known. Anything else is either a
// mistake or an attack, and both should stop here.
const ALLOWED_REGISTRY_HOSTS = new Set([
  'gitlab.com',
  'npm.pkg.github.com',
  'registry.tetrasaas.com',
]);

// C0/C1 controls and Unicode format characters. Newlines are controls too, which
// is the point: a value that may not span lines cannot inject a second directive.
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Single-line by construction. Used for every value that ends up as a whole line
// in an npm config or as `KEY=value` in .env.
function requireLine(value, label, { maxLength = 4096 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Control plane returned an invalid ${label}.`);
  }
  if (UNPRINTABLE.test(value)) {
    throw new Error(`Control plane returned a ${label} containing control characters.`);
  }
  return value;
}

// npm treats a registry with and without a trailing slash as the same thing, but
// when two auth entries exist for one registry the trailing-slash form wins. So
// we canonicalise before deriving anything: the key we write must be the key npm
// prefers, or a stale entry of the customer's silently outranks it.
function canonicalRegistryUrl(url) {
  const canonical = new URL(url.href);
  if (!canonical.pathname.endsWith('/')) canonical.pathname += '/';
  return canonical;
}

// There is deliberately no localhost exception here. Anything that relaxes the
// host or the protocol has to be injected by a caller, so production cannot
// reach it: the project install runs the customer's real project and therefore
// runs lifecycle scripts, which makes an attacker-controlled registry code
// execution.
function requireRegistryUrl(value, label, { allowedHosts = ALLOWED_REGISTRY_HOSTS, allowInsecure = false } = {}) {
  const raw = requireLine(value, label, { maxLength: 2048 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Control plane returned an invalid ${label}.`);
  }
  if (url.protocol !== 'https:' && !allowInsecure) {
    throw new Error(`Control plane returned a non-HTTPS ${label}.`);
  }
  // Credentials in the URL would end up in whatever file we write it to, which
  // defeats the point of keeping the committed config secret-free.
  if (url.username || url.password) {
    throw new Error(`Control plane returned a ${label} containing credentials.`);
  }
  if (!allowedHosts.has(url.hostname)) {
    throw new Error(`Control plane returned a ${label} on an unexpected host.`);
  }
  return canonicalRegistryUrl(url);
}

// npm identifies a registry auth entry by the registry URL with the protocol
// stripped. npm-registry-fetch walks that path upwards from the request URI, so
// the full pathname is the most specific key that still matches — which is what
// we want: it authenticates this registry and no sibling path on the same host.
export function authKeyFor(registryUrl) {
  return `//${registryUrl.host}${registryUrl.pathname}`;
}

// The template the control plane sends is cross-checked against the registry we
// validated. We do not write it verbatim — see renderProjectFiles — but a
// template that disagrees with the registry means something is wrong upstream.
function validateNpmrcTemplate(template, { scope, registryUrl }) {
  if (typeof template !== 'string' || template.length === 0 || template.length > 4096) {
    throw new Error('Control plane returned an invalid npmrc template.');
  }
  // Newlines are the only control character a template may contain, and only as
  // line separators. A bare \r would let npm's ini parser see a line this check
  // never inspected.
  if (UNPRINTABLE.test(template.replaceAll('\n', ''))) {
    throw new Error('Control plane returned an npmrc template containing control characters.');
  }

  const expectedAuth = `${authKeyFor(registryUrl)}:_authToken=\${NPM_TOKEN}`;
  let registryLines = 0;
  let authLines = 0;

  for (const raw of template.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;

    if (line.startsWith(`${scope}:registry=`)) {
      registryLines += 1;
      const declared = line.slice(`${scope}:registry=`.length);
      let url;
      try {
        url = new URL(declared);
      } catch {
        throw new Error('Control plane returned an npmrc template with an invalid registry URL.');
      }
      if (canonicalRegistryUrl(url).href !== registryUrl.href) {
        throw new Error('Control plane returned an npmrc template pointing at a different registry.');
      }
      continue;
    }

    if (line.includes(':_authToken=')) {
      authLines += 1;
      // Accept the form the control plane happens to send; what we write is
      // canonical either way.
      if (line !== expectedAuth && line !== expectedAuth.replace('/:_authToken=', ':_authToken=')) {
        throw new Error('Control plane returned an npmrc template authenticating a different host.');
      }
      continue;
    }

    if (line === 'always-auth=true') continue;

    throw new Error('Control plane returned an npmrc template with an unexpected directive.');
  }

  if (registryLines !== 1) {
    throw new Error('Control plane returned an npmrc template without exactly one registry line.');
  }
  if (authLines !== 1) {
    throw new Error('Control plane returned an npmrc template without exactly one token line.');
  }

  return template;
}

export function validateClaim(value, { allowedHosts, allowInsecure } = {}) {
  if (!isRecord(value) || !isRecord(value.package_registry)) {
    throw new Error('Control plane returned an invalid onboarding claim.');
  }

  const registry = value.package_registry;
  for (const key of REGISTRY_KEYS) {
    if (!(key in registry)) {
      throw new Error(`Control plane omitted package_registry.${key}.`);
    }
  }

  const scope = requireLine(registry.scope, 'package scope', { maxLength: 128 });
  if (!/^@[a-z0-9][a-z0-9._-]*$/.test(scope)) {
    throw new Error('Control plane returned an invalid package scope.');
  }

  const registryUrl = requireRegistryUrl(registry.npm_registry_url, 'registry URL', { allowedHosts, allowInsecure });
  validateNpmrcTemplate(registry.npmrc_template, { scope, registryUrl });

  return {
    // Both of these become `KEY=value` lines in .env, so a newline in either one
    // would let the control plane define extra environment variables.
    licenseKey: requireLine(value.license_key, 'licence key', { maxLength: 8192 }),
    registry: {
      provider: requireLine(registry.provider, 'registry provider', { maxLength: 64 }),
      scope,
      url: registryUrl.href,
      authKey: authKeyFor(registryUrl),
      token: requireLine(registry.token, 'registry token', { maxLength: 4096 }),
    },
    licenseVerification: isRecord(value.license_verification)
      ? {
          publicKeysJson: requireLine(
            value.license_verification.public_keys_json,
            'licence public keys',
            { maxLength: 16384 },
          ),
        }
      : null,
  };
}

// npm reads credentials from the user-level npmrc and registry mapping from the
// project. Splitting them the way npm intends is what makes `npm install` keep
// working: the project file carries no secret and no ${NPM_TOKEN} placeholder
// that npm would send literally, and the token lives where npm login puts it.
export function renderProjectFiles(claim) {
  const projectNpmrc = [
    `${claim.registry.scope}:registry=${claim.registry.url}`,
    'engine-strict=true',
    '',
  ].join('\n');

  const userNpmrcEntry = `${claim.registry.authKey}:_authToken=${claim.registry.token}`;

  const env = [
    '# Written by create-tetra. Keep this file out of version control.',
    `TETRA_LICENSE_KEY=${claim.licenseKey}`,
    ...(claim.licenseVerification
      ? [`TETRA_LICENSE_PUBLIC_KEYS_JSON=${claim.licenseVerification.publicKeysJson}`]
      : []),
    '# Only needed in CI, where there is no user-level npm config.',
    `NPM_TOKEN=${claim.registry.token}`,
    '',
  ].join('\n');

  return { projectNpmrc, userNpmrcEntry, env, token: claim.registry.token, authKey: claim.registry.authKey };
}

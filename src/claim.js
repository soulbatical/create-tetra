// The onboarding claim is the one response that legitimately carries credentials:
// a per-customer read-only registry token and a runtime licence key. It is fetched
// over a one-time bearer grant and never printed.
//
// Everything here is written into the customer's project, so validation is not a
// formality. A compromised control plane that can put an arbitrary registry into
// .npmrc, or an arbitrary line into .env, owns the machine that runs the install.

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

// C0/C1 controls and Unicode format characters. Newlines are controls too, which
// is the point: a value that may not span lines cannot inject a second directive.
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Single-line by construction. Used for every value that ends up as a whole line
// in .npmrc or as `KEY=value` in .env.
function requireLine(value, label, { maxLength = 4096 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Control plane returned an invalid ${label}.`);
  }
  if (UNPRINTABLE.test(value)) {
    throw new Error(`Control plane returned a ${label} containing control characters.`);
  }
  return value;
}

function requireHttpsUrl(value, label) {
  const raw = requireLine(value, label, { maxLength: 2048 });
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Control plane returned an invalid ${label}.`);
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !local) {
    throw new Error(`Control plane returned a non-HTTPS ${label}.`);
  }
  return url;
}

// npm identifies a registry auth entry by the registry URL with the protocol
// stripped, so this is the only form that can authenticate the registry we
// validated — and nothing else.
function authHostPathFor(registryUrl) {
  return `//${registryUrl.host}${registryUrl.pathname}`;
}

// The template is written verbatim into the customer's .npmrc. It may contain
// exactly three kinds of line, at most one of each meaningful kind, and the
// registry it names must be the registry we validated.
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

  const expectedAuth = `${authHostPathFor(registryUrl)}:_authToken=\${NPM_TOKEN}`;
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
      // Not "starts with the right thing" — the same registry, or nothing.
      if (url.href !== registryUrl.href) {
        throw new Error('Control plane returned an npmrc template pointing at a different registry.');
      }
      continue;
    }

    if (line.includes(':_authToken=')) {
      authLines += 1;
      if (line !== expectedAuth) {
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

export function validateClaim(value) {
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

  const registryUrl = requireHttpsUrl(registry.npm_registry_url, 'registry URL');
  const npmrcTemplate = validateNpmrcTemplate(registry.npmrc_template, { scope, registryUrl });

  return {
    // Both of these become `KEY=value` lines in .env, so a newline in either one
    // would let the control plane define extra environment variables.
    licenseKey: requireLine(value.license_key, 'licence key', { maxLength: 8192 }),
    registry: {
      provider: requireLine(registry.provider, 'registry provider', { maxLength: 64 }),
      scope,
      url: registryUrl.href,
      token: requireLine(registry.token, 'registry token', { maxLength: 4096 }),
      npmrcTemplate,
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

// What we write into the project. NPM_TOKEN stays in .env rather than being
// inlined into .npmrc, so the file that usually gets committed carries no secret.
export function renderProjectFiles(claim) {
  const npmrc = `${claim.registry.npmrcTemplate.trimEnd()}\nengine-strict=true\n`;

  const env = [
    '# Written by create-tetra. Keep this file out of version control.',
    `NPM_TOKEN=${claim.registry.token}`,
    `TETRA_LICENSE_KEY=${claim.licenseKey}`,
    ...(claim.licenseVerification
      ? [`TETRA_LICENSE_PUBLIC_KEYS_JSON=${claim.licenseVerification.publicKeysJson}`]
      : []),
    '',
  ].join('\n');

  return { npmrc, env };
}

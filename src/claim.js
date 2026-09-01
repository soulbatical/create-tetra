// The onboarding claim is the one response that legitimately carries credentials:
// a per-customer read-only registry token and a runtime licence key. It is fetched
// over a one-time bearer grant and never printed.
//
// Shape mirrors buildOnboardingClaimPayload on the control plane. Validation is
// strict on purpose: this payload decides what we write into the customer's
// project, so an unexpected field is a reason to stop, not to improvise.

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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireField(value, label, { maxLength = 4096 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`Control plane returned an invalid ${label}.`);
  }
  // Same rule as the display strings: nothing that can rewrite a terminal or a
  // config file behind our back.
  if (/[\p{Cc}\p{Cf}]/u.test(value.replace(/\n/g, ''))) {
    throw new Error(`Control plane returned an invalid ${label}.`);
  }
  return value;
}

function requireHttpsUrl(value, label) {
  const raw = requireField(value, label, { maxLength: 2048 });
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
  return url.toString();
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

  const scope = requireField(registry.scope, 'package scope', { maxLength: 128 });
  if (!/^@[a-z0-9][a-z0-9._-]*$/.test(scope)) {
    throw new Error('Control plane returned an invalid package scope.');
  }

  const npmrcTemplate = requireField(registry.npmrc_template, 'npmrc template', { maxLength: 4096 });
  // The template is written verbatim into the customer's .npmrc, so it may not
  // smuggle in extra directives that point somewhere else.
  for (const line of npmrcTemplate.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const allowed =
      trimmed.startsWith(`${scope}:registry=`) ||
      /^\/\/[^\s=]+:_authToken=\$\{NPM_TOKEN\}$/.test(trimmed) ||
      trimmed === 'always-auth=true';
    if (!allowed) {
      throw new Error('Control plane returned an npmrc template with an unexpected directive.');
    }
  }
  if (npmrcTemplate.includes('${NPM_TOKEN}') === false) {
    throw new Error('Control plane returned an npmrc template without a token placeholder.');
  }

  return {
    licenseKey: requireField(value.license_key, 'licence key', { maxLength: 8192 }),
    registry: {
      provider: requireField(registry.provider, 'registry provider', { maxLength: 64 }),
      scope,
      url: requireHttpsUrl(registry.npm_registry_url, 'registry URL'),
      token: requireField(registry.token, 'registry token', { maxLength: 4096 }),
      npmrcTemplate,
    },
    licenseVerification: isRecord(value.license_verification)
      ? {
          publicKeysJson: requireField(
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

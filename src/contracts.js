const TARGETS = new Set(['local', 'netlify-preview', 'railway-pr']);
const TARGET_STATUSES = new Set(['configured', 'unchanged', 'planned', 'failed', 'skipped']);
const CHECK_STATUSES = new Set(['passed', 'failed', 'skipped']);
const RESULT_KEYS = [
  'access_mode',
  'configured_targets',
  'npmrc_mode',
  'license_configured',
  'clean_cache_checks',
  'issues',
  'next_actions',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Control plane returned an invalid ${label}.`);
  }
  return value;
}

export function validateAuthorization(value, { approvalOrigin = 'https://app.tetrasaas.com' } = {}) {
  if (!isRecord(value)) throw new Error('Control plane returned an invalid authorization.');
  const verificationUri = new URL(requireString(value.verification_uri, 'verification URI'));
  const isProductionApproval = approvalOrigin === 'https://app.tetrasaas.com';
  if ((isProductionApproval && verificationUri.protocol !== 'https:') || verificationUri.origin !== approvalOrigin) {
    throw new Error('Control plane returned an untrusted browser approval URL.');
  }
  const expiresAt = Date.parse(requireString(value.expires_at, 'authorization expiry'));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('Control plane returned an expired authorization.');
  }
  const intervalSeconds = Number(value.interval_seconds);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 30) {
    throw new Error('Control plane returned an invalid polling interval.');
  }
  return {
    authorizationId: requireString(value.authorization_id, 'authorization ID'),
    deviceCode: requireString(value.device_code, 'device code'),
    userCode: requireString(value.user_code, 'user code'),
    verificationUri: verificationUri.toString(),
    intervalSeconds,
    expiresAt,
  };
}

export function validateAuthorizationStatus(value) {
  if (!isRecord(value)) throw new Error('Control plane returned an invalid authorization status.');
  if (value.status === 'pending') return { status: 'pending' };
  if (value.status === 'denied') return { status: 'denied' };
  if (value.status === 'expired') return { status: 'expired' };
  if (value.status !== 'approved') throw new Error('Control plane returned an unknown authorization status.');
  return {
    status: 'approved',
    installGrant: requireString(value.install_grant, 'install grant'),
  };
}

export function validateInstallResult(value) {
  if (!isRecord(value)) throw new Error('Control plane returned an invalid install result.');
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...RESULT_KEYS].sort())) {
    throw new Error('Control plane returned an install result outside the frozen contract.');
  }
  if (!['public', 'private'].includes(value.access_mode)) throw new Error('Invalid access mode.');
  if (!['public-engine-strict', 'private-env-placeholder'].includes(value.npmrc_mode)) {
    throw new Error('Invalid npmrc mode.');
  }
  if (typeof value.license_configured !== 'boolean') throw new Error('Invalid license status.');
  if (!Array.isArray(value.configured_targets) || !Array.isArray(value.clean_cache_checks)) {
    throw new Error('Invalid target results.');
  }
  for (const item of value.configured_targets) {
    if (!isRecord(item) || !TARGETS.has(item.target) || !TARGET_STATUSES.has(item.status)) {
      throw new Error('Invalid configured target result.');
    }
  }
  for (const item of value.clean_cache_checks) {
    if (!isRecord(item) || !TARGETS.has(item.target) || !CHECK_STATUSES.has(item.status)) {
      throw new Error('Invalid clean-cache result.');
    }
  }
  if (!Array.isArray(value.issues) || !Array.isArray(value.next_actions)) {
    throw new Error('Invalid install guidance.');
  }
  return value;
}

export function formatInstallResult(result) {
  const targetLines = result.configured_targets.map(({ target, status }) => `  - ${target}: ${status}`);
  const cacheLines = result.clean_cache_checks.map(({ target, status }) => `  - ${target}: ${status}`);
  return [
    '',
    'Tetra-installatie afgerond.',
    `Package access: ${result.access_mode}`,
    `npm-configuratie: ${result.npmrc_mode}`,
    `Runtime-licentie: ${result.license_configured ? 'configured' : 'not configured'}`,
    'Doelen:',
    ...targetLines,
    'Lege-cachecontroles:',
    ...cacheLines,
    `Issues: ${result.issues.length}`,
    `Volgende acties: ${result.next_actions.length}`,
    '',
  ].join('\n');
}

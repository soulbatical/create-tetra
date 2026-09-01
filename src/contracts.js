const AUTHORIZATION_KEYS = [
  'authorization_id',
  'device_code',
  'expires_at',
  'interval_seconds',
  'user_code',
  'verification_uri',
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw new Error(`Control plane returned an invalid ${label}.`);
  }
  return value;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Control plane returned ${label} outside the frozen contract.`);
  }
}

export function validateAuthorization(value, { approvalOrigin } = {}) {
  if (!isRecord(value)) throw new Error('Control plane returned an invalid authorization.');
  requireExactKeys(value, AUTHORIZATION_KEYS, 'an authorization');

  const verificationUri = new URL(requireString(value.verification_uri, 'verification URI'));
  const isProductionApproval = approvalOrigin?.startsWith('https:') ?? true;
  if ((isProductionApproval && verificationUri.protocol !== 'https:') || verificationUri.origin !== approvalOrigin) {
    throw new Error('Control plane returned an untrusted browser approval URL.');
  }

  const expiresAt = Date.parse(requireString(value.expires_at, 'authorization expiry'));
  const now = Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 15 * 60_000) {
    throw new Error('Control plane returned an expired authorization.');
  }

  const intervalSeconds = Number(value.interval_seconds);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 30) {
    throw new Error('Control plane returned an invalid polling interval.');
  }

  const userCode = requireString(value.user_code, 'user code');
  if (!/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?$/.test(userCode)) {
    throw new Error('Control plane returned an invalid user code.');
  }

  return {
    authorizationId: requireString(value.authorization_id, 'authorization ID'),
    deviceCode: requireString(value.device_code, 'device code'),
    userCode,
    verificationUri: verificationUri.toString(),
    intervalSeconds,
    expiresAt,
  };
}

export function validateAuthorizationStatus(value) {
  if (!isRecord(value)) throw new Error('Control plane returned an invalid authorization status.');
  if (['pending', 'denied', 'expired'].includes(value.status)) {
    requireExactKeys(value, ['status'], 'an authorization status');
    return { status: value.status };
  }
  if (value.status !== 'approved') throw new Error('Control plane returned an unknown authorization status.');
  requireExactKeys(value, ['status', 'install_grant'], 'an authorization status');
  return {
    status: 'approved',
    installGrant: requireString(value.install_grant, 'install grant'),
  };
}

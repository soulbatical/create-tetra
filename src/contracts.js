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

function requireDisplayString(value, label) {
  const text = requireString(value, label);
  if (text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`Control plane returned an invalid ${label}.`);
  }
  return text;
}

function requireCode(value, label) {
  const code = requireString(value, label);
  if (!/^[a-z0-9_]{1,64}$/.test(code)) throw new Error(`Control plane returned an invalid ${label}.`);
  return code;
}

function requireExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Control plane returned ${label} outside the frozen contract.`);
  }
}

function requireTarget(value, label) {
  if (!TARGETS.has(value)) throw new Error(`Control plane returned an invalid ${label}.`);
  return value;
}

export function validateAuthorization(value, { approvalOrigin = 'https://app.tetrasaas.com' } = {}) {
  if (!isRecord(value)) throw new Error('Control plane returned an invalid authorization.');
  requireExactKeys(value, AUTHORIZATION_KEYS, 'an authorization');
  const verificationUri = new URL(requireString(value.verification_uri, 'verification URI'));
  const isProductionApproval = approvalOrigin === 'https://app.tetrasaas.com';
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
  return {
    authorizationId: requireString(value.authorization_id, 'authorization ID'),
    deviceCode: requireString(value.device_code, 'device code'),
    userCode: (() => {
      const code = requireString(value.user_code, 'user code');
      if (!/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12})?$/.test(code)) {
        throw new Error('Control plane returned an invalid user code.');
      }
      return code;
    })(),
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

export function validateInstallResult(value) {
  if (!isRecord(value)) throw new Error('Control plane returned an invalid install result.');
  requireExactKeys(value, RESULT_KEYS, 'an install result');
  if (!['public', 'private'].includes(value.access_mode)) throw new Error('Invalid access mode.');
  if (!['public-engine-strict', 'private-env-placeholder'].includes(value.npmrc_mode)) {
    throw new Error('Invalid npmrc mode.');
  }
  if (typeof value.license_configured !== 'boolean') throw new Error('Invalid license status.');
  if (!Array.isArray(value.configured_targets) || !Array.isArray(value.clean_cache_checks)) {
    throw new Error('Invalid target results.');
  }
  const configuredTargets = value.configured_targets.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid configured target result.');
    requireExactKeys(item, ['target', 'status'], 'a configured target result');
    if (!TARGETS.has(item.target) || !TARGET_STATUSES.has(item.status)) {
      throw new Error('Invalid configured target result.');
    }
    return { target: item.target, status: item.status };
  });
  const cleanCacheChecks = value.clean_cache_checks.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid clean-cache result.');
    requireExactKeys(item, ['target', 'status'], 'a clean-cache result');
    if (!TARGETS.has(item.target) || !CHECK_STATUSES.has(item.status)) {
      throw new Error('Invalid clean-cache result.');
    }
    return { target: item.target, status: item.status };
  });
  if (new Set(configuredTargets.map(({ target }) => target)).size !== configuredTargets.length) {
    throw new Error('Duplicate configured target result.');
  }
  if (new Set(cleanCacheChecks.map(({ target }) => target)).size !== cleanCacheChecks.length) {
    throw new Error('Duplicate clean-cache result.');
  }
  if (!Array.isArray(value.issues) || !Array.isArray(value.next_actions)) {
    throw new Error('Invalid install guidance.');
  }
  const issues = value.issues.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid install issue.');
    const keys = item.target === undefined ? ['code', 'summary', 'recoverable'] : ['code', 'target', 'summary', 'recoverable'];
    requireExactKeys(item, keys, 'an install issue');
    if (typeof item.recoverable !== 'boolean') throw new Error('Invalid install issue.');
    return {
      code: requireCode(item.code, 'issue code'),
      ...(item.target === undefined ? {} : { target: requireTarget(item.target, 'issue target') }),
      summary: requireDisplayString(item.summary, 'issue summary'),
      recoverable: item.recoverable,
    };
  });
  const nextActions = value.next_actions.map((item) => {
    if (!isRecord(item)) throw new Error('Invalid next action.');
    const keys = item.target === undefined ? ['code', 'description'] : ['code', 'target', 'description'];
    requireExactKeys(item, keys, 'a next action');
    return {
      code: requireCode(item.code, 'next-action code'),
      ...(item.target === undefined ? {} : { target: requireTarget(item.target, 'next-action target') }),
      description: requireDisplayString(item.description, 'next-action description'),
    };
  });
  return {
    access_mode: value.access_mode,
    configured_targets: configuredTargets,
    npmrc_mode: value.npmrc_mode,
    license_configured: value.license_configured,
    clean_cache_checks: cleanCacheChecks,
    issues,
    next_actions: nextActions,
  };
}

export function summarizeInstallResult(result) {
  const statuses = result.configured_targets.map(({ status }) => status);
  const blocked = statuses.includes('failed') || result.issues.some(({ recoverable }) => !recoverable);
  if (blocked) return 'failed';
  const applied = statuses.filter((status) => status === 'configured' || status === 'unchanged').length;
  if (applied === 0) return 'planned';
  return applied === statuses.length && result.issues.length === 0 ? 'completed' : 'partial';
}

const OUTCOME_HEADLINES = {
  completed: 'Tetra-installatie afgerond.',
  partial: 'Tetra-installatie gedeeltelijk afgerond; niet elk doel is geconfigureerd.',
  planned: 'Tetra heeft de installatie voorbereid. Er is nog niets geinstalleerd.',
  failed: 'Tetra-installatie mislukt. Er is niets bruikbaars opgeleverd.',
};

export function formatInstallResult(result, outcome = summarizeInstallResult(result)) {
  const section = (title, lines) => (lines.length === 0 ? [] : [title, ...lines]);
  return [
    '',
    OUTCOME_HEADLINES[outcome],
    `Package access: ${result.access_mode}`,
    `npm-configuratie: ${result.npmrc_mode}`,
    `Runtime-licentie: ${result.license_configured ? 'configured' : 'not configured'}`,
    'Doelen:',
    ...result.configured_targets.map(({ target, status }) => `  - ${target}: ${status}`),
    ...section('Lege-cachecontroles:', result.clean_cache_checks.map(({ target, status }) => `  - ${target}: ${status}`)),
    ...section('Issues:', result.issues.map((issue) => {
      const scope = issue.target ? `${issue.target}/` : '';
      return `  - [${scope}${issue.code}] ${issue.summary}${issue.recoverable ? '' : ' (niet herstelbaar)'}`;
    })),
    ...section('Volgende acties:', result.next_actions.map((action) => {
      const scope = action.target ? `${action.target}/` : '';
      return `  - [${scope}${action.code}] ${action.description}`;
    })),
    '',
  ].join('\n');
}

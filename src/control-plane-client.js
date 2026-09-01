import { validateAuthorization, validateAuthorizationStatus, validateInstallResult } from './contracts.js';

const DEFAULT_BASE_URL = 'https://api.tetrasaas.com';

function safeApiError(status, body) {
  const rawCode = body && typeof body === 'object' && typeof body.code === 'string' ? body.code : '';
  const code = /^[a-z0-9_]{1,64}$/.test(rawCode) ? ` (${rawCode})` : '';
  return new Error(`Control plane request failed with HTTP ${status}${code}.`);
}

export function createControlPlaneClient({
  baseUrl = DEFAULT_BASE_URL,
  approvalOrigin = 'https://app.tetrasaas.com',
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' && origin.hostname !== '127.0.0.1' && origin.hostname !== 'localhost') {
    throw new Error('Control plane must use HTTPS.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('This Node runtime does not provide fetch.');

  async function request(path, body) {
    const response = await fetchImpl(new URL(path, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A malformed body is reported without echoing it; it may contain secrets.
    }
    if (!response.ok) throw safeApiError(response.status, payload);
    return payload;
  }

  return {
    async requestAuthorization(input) {
      return validateAuthorization(await request('/v1/cli/authorizations', input), { approvalOrigin });
    },
    async pollAuthorization(deviceCode) {
      return validateAuthorizationStatus(await request('/v1/cli/authorizations/poll', { device_code: deviceCode }));
    },
    async install({ installGrant, projectName, targets, verifyCleanCache }) {
      return validateInstallResult(await request('/v1/cli/installations', {
        install_grant: installGrant,
        project: { name: projectName },
        targets,
        verify_clean_cache: verifyCleanCache,
      }));
    },
  };
}

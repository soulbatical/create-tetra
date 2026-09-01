import { validateAuthorization, validateAuthorizationStatus } from './contracts.js';
import { validateClaim } from './claim.js';

// One host. The approval page and the API live on the same origin as the site,
// so there is no separate api./app. subdomain to keep in sync.
const DEFAULT_BASE_URL = 'https://www.tetrasaas.com';

function safeApiError(status) {
  return new Error(`Control plane request failed with HTTP ${status}.`);
}

export function createControlPlaneClient({
  baseUrl = DEFAULT_BASE_URL,
  approvalOrigin = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' && origin.hostname !== '127.0.0.1' && origin.hostname !== 'localhost') {
    throw new Error('Control plane must use HTTPS.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('This Node runtime does not provide fetch.');

  async function request(path, body, { bearer } = {}) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;

    const response = await fetchImpl(new URL(path, origin), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // A malformed body is reported without echoing it; it may contain secrets.
    }
    if (!response.ok) throw safeApiError(response.status);
    return payload;
  }

  return {
    async requestAuthorization(input) {
      return validateAuthorization(await request('/api/tetra/cli/authorizations', input), {
        approvalOrigin,
      });
    },
    async pollAuthorization(deviceCode) {
      return validateAuthorizationStatus(
        await request('/api/tetra/cli/authorizations/poll', { device_code: deviceCode }),
      );
    },
    // The grant is spent here: it is sent as a bearer and is single-use, so this
    // call happens exactly once and its result is never logged.
    async claim(installGrant) {
      return validateClaim(await request('/api/tetra/onboarding/claim', {}, { bearer: installGrant }));
    },
  };
}

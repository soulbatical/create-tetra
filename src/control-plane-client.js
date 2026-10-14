import { validateAuthorization, validateAuthorizationStatus } from './contracts.js';
import { validateClaim } from './claim.js';

// One host. The approval page and the API live on the same origin as the site,
// so there is no separate api./app. subdomain to keep in sync.
//
// The apex, not www: www 301s to the apex, and requests here use
// redirect: 'error' on purpose, so every call would throw before reaching a
// handler. Measured, not assumed.
const DEFAULT_BASE_URL = 'https://tetrasaas.com';

function safeApiError(status) {
  return new Error(`Control plane request failed with HTTP ${status}.`);
}

// A single 5xx or 429 does not mean the flow is broken — it measured, in
// production, as a transient blip the very next call recovered from. Without
// a retry here that one blip was indistinguishable from a dead control plane,
// and create-tetra threw the customer's whole run away over it. Three
// attempts with a short exponential backoff absorbs that without masking a
// control plane that is actually down: by the third failure in under two
// seconds, it is.
const DEFAULT_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 300;

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

export function createControlPlaneClient({
  baseUrl = DEFAULT_BASE_URL,
  approvalOrigin = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  retryAttempts = DEFAULT_RETRY_ATTEMPTS,
} = {}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' && origin.hostname !== '127.0.0.1' && origin.hostname !== 'localhost') {
    throw new Error('Control plane must use HTTPS.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('This Node runtime does not provide fetch.');

  // `retryable: false` is what keeps this from quietly turning a single-use
  // call into a multi-use one. A grant can be spent at most once: if the
  // control plane processed a claim and only the *response* was lost to a
  // network blip, retrying resends a now-dead grant and turns a successful
  // install into a confusing 401 — or, if the server side ever has a gap,
  // mints a second set of credentials for one approval. Review caught this
  // on the first pass (soulbatical/create-tetra#6): the retry had been added
  // to the one layer every call shares, which is exactly the layer that
  // cannot tell a safe-to-repeat request from one that was not.
  async function request(path, body, { bearer, retryable = true } = {}) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (bearer) headers.authorization = `Bearer ${bearer}`;

    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(new URL(path, origin), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        // A network failure (reset connection, DNS, our own 30s timeout)
        // never reached the server, so it carries the same retry question as
        // a 5xx — and the same answer for a non-retryable call: do not repeat
        // something that may not be safe to repeat.
        if (!retryable || attempt >= retryAttempts) throw error;
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // A malformed body is reported without echoing it; it may contain secrets.
      }
      if (response.ok) return payload;

      if (!retryable || !isRetryableStatus(response.status) || attempt >= retryAttempts) {
        throw safeApiError(response.status);
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
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
    // call happens exactly once and its result is never logged. retryable:
    // false for the same reason — a lost response must not become a second
    // attempt to spend a grant that may already be gone.
    async claim(installGrant) {
      return validateClaim(
        await request('/api/tetra/onboarding/claim', {}, { bearer: installGrant, retryable: false }),
      );
    },
  };
}

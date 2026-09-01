import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

import { runCreateTetra } from '../src/cli.js';
import { createControlPlaneClient } from '../src/control-plane-client.js';

const apiPort = Number(process.env.CREATE_TETRA_PREVIEW_API_PORT ?? 3042);
const webPort = Number(process.env.CREATE_TETRA_PREVIEW_WEB_PORT ?? 5132);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://localhost:${webPort}`;
const requests = new Map();

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const api = createServer(async (request, response) => {
  if (request.method !== 'POST') return json(response, 404, { code: 'not_found' });
  const body = await readJson(request);
  if (request.url === '/v1/cli/authorizations') {
    const authorizationId = randomUUID();
    const deviceCode = randomBytes(32).toString('base64url');
    const userCode = randomBytes(4).toString('hex').toUpperCase();
    requests.set(authorizationId, {
      authorizationId, deviceCode, userCode, status: 'pending',
      projectName: body.project?.name ?? 'tetra-app', installGrant: null,
    });
    return json(response, 201, {
      authorization_id: authorizationId,
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${webOrigin}/approve?id=${authorizationId}`,
      interval_seconds: 1,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
  }
  if (request.url === '/v1/cli/authorizations/poll') {
    const entry = [...requests.values()].find((candidate) => candidate.deviceCode === body.device_code);
    if (!entry) return json(response, 404, { code: 'authorization_not_found' });
    if (entry.status === 'approved') return json(response, 200, { status: 'approved', install_grant: entry.installGrant });
    return json(response, 200, { status: entry.status });
  }
  if (request.url === '/v1/cli/installations') {
    const entry = [...requests.values()].find((candidate) => candidate.installGrant === body.install_grant);
    if (!entry || entry.status !== 'approved') return json(response, 403, { code: 'invalid_install_grant' });
    return json(response, 200, {
      access_mode: 'private',
      configured_targets: [{ target: 'local', status: 'planned' }],
      npmrc_mode: 'private-env-placeholder',
      license_configured: true,
      clean_cache_checks: [{ target: 'local', status: 'passed' }],
      issues: [],
      next_actions: [{ code: 'preview_only', target: 'local', description: 'Preview bewezen; echte package-installatie volgt pas na publieke release.' }],
    });
  }
  return json(response, 404, { code: 'not_found' });
});

const web = createServer((request, response) => {
  const url = new URL(request.url, webOrigin);
  const entry = requests.get(url.searchParams.get('id'));
  if (!entry) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end('Installatieverzoek niet gevonden.');
  }
  if (request.method === 'POST') {
    const action = url.searchParams.get('action');
    entry.status = action === 'approve' ? 'approved' : 'denied';
    if (entry.status === 'approved') entry.installGrant = randomBytes(32).toString('base64url');
  }
  const decided = entry.status !== 'pending';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<!doctype html><html lang="nl"><meta name="viewport" content="width=device-width"><title>Tetra-installatie goedkeuren</title><style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#07111f;color:#f7f3e8}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}.card{width:min(640px,100%);background:#101d2d;border:1px solid #29405a;border-radius:24px;padding:32px;box-shadow:0 30px 80px #0008}.eyebrow{font:700 12px ui-monospace;color:#67e8f9;letter-spacing:.12em;text-transform:uppercase}h1{font-size:34px;margin:12px 0 8px}.sub{color:#b8c4d1;line-height:1.6}.facts{margin:28px 0;display:grid;gap:12px}.fact{background:#0a1625;border-radius:14px;padding:16px}.fact b{display:block;color:#c7ff4a;margin-bottom:5px}.actions{display:flex;gap:12px;flex-wrap:wrap}button{border:0;border-radius:999px;padding:13px 22px;font-weight:800;cursor:pointer}.approve{background:#c7ff4a;color:#07111f}.deny{background:#24364b;color:#f7f3e8}.done{padding:16px;border-radius:14px;background:#122c29;color:#9ff7d0}</style><main class="card"><div class="eyebrow">Tetra secure install preview</div><h1>Installatie goedkeuren</h1><p class="sub">Controleer wat er wordt aangevraagd. Er worden geen package-token of licentiewaarden getoond.</p><section class="facts"><div class="fact"><b>Organisatie</b>Demo Horeca B.V.</div><div class="fact"><b>Licentie</b>Tetra Demo · actief</div><div class="fact"><b>Project</b>${entry.projectName.replaceAll('<','&lt;')}</div><div class="fact"><b>Actie</b>Lokale Tetra-app installeren en lege cache controleren</div><div class="fact"><b>Bevestigingscode</b>${entry.userCode}</div></section>${decided ? `<div class="done">${entry.status === 'approved' ? 'Goedgekeurd. Je kunt terug naar de terminal.' : 'Geweigerd. Er wordt niets geïnstalleerd.'}</div>` : `<div class="actions"><form method="post" action="/approve?id=${entry.authorizationId}&action=approve"><button class="approve">Goedkeuren en installeren</button></form><form method="post" action="/approve?id=${entry.authorizationId}&action=deny"><button class="deny">Weigeren</button></form></div>`}</main></html>`);
});

await Promise.all([
  new Promise((resolveListen) => api.listen(apiPort, '127.0.0.1', resolveListen)),
  new Promise((resolveListen) => web.listen(webPort, '127.0.0.1', resolveListen)),
]);

try {
  await runCreateTetra({
    argv: process.argv.slice(2),
    version: '0.0.0',
    client: createControlPlaneClient({ baseUrl: apiOrigin, approvalOrigin: webOrigin }),
    browser: (url) => {
      process.stdout.write(`\nBrowserpreview: ${url}\n`);
      if (process.env.CREATE_TETRA_PREVIEW_OPEN !== '0') {
        const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
        child.unref();
      }
    },
  });
} finally {
  api.close();
  web.close();
}

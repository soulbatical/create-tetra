import assert from 'node:assert/strict';
import test from 'node:test';

import { runCreateTetra } from '../src/cli.js';

const SECRETS = ['device-secret', 'grant-secret', 'deploy-token-value'];

const claim = {
  licenseKey: 'licence-secret',
  registry: {
    provider: 'gitlab',
    scope: '@soulbatical',
    url: 'https://gitlab.com/api/v4/projects/85262758/packages/npm/',
    authKey: '//gitlab.com/api/v4/projects/85262758/packages/npm/',
    token: 'deploy-token-value',
  },
  licenseVerification: { publicKeysJson: '{"keys":[]}' },
};

function stubClient({ pollStatuses = [{ status: 'approved', installGrant: 'grant-secret' }] } = {}) {
  const calls = [];
  const queue = [...pollStatuses];
  return {
    calls,
    async requestAuthorization(input) {
      calls.push(['authorize', input]);
      return {
        authorizationId: 'auth-id',
        deviceCode: SECRETS[0],
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://www.tetrasaas.com/install/approve?request=public-id',
        intervalSeconds: 1,
        expiresAt: Date.now() + 60_000,
      };
    },
    async pollAuthorization(deviceCode) {
      calls.push(['poll', deviceCode]);
      return queue.shift() ?? { status: 'pending' };
    },
    async claim(grant) {
      calls.push(['claim', grant]);
      return claim;
    },
  };
}

test('approval leads to a real project, and no secret is ever printed', async () => {
  let output = '';
  const installs = [];
  const client = stubClient();

  const result = await runCreateTetra({
    argv: ['horeca-crm'],
    cwd: '/tmp',
    version: '1.0.0',
    client,
    checkDirectory: async () => true,
    browser: () => {},
    write: (text) => { output += text; },
    sleep: async () => {},
    install: async (options) => {
      installs.push(options);
      return { projectPath: options.projectPath, projectName: options.projectName };
    },
  });

  assert.equal(result.kind, 'installed');
  assert.equal(installs.length, 1);
  assert.equal(installs[0].projectName, 'horeca-crm');
  assert.equal(installs[0].projectPath, '/tmp/horeca-crm');
  assert.match(installs[0].files.projectNpmrc, /@soulbatical:registry=/);
  assert.equal(installs[0].files.projectNpmrc.includes('deploy-token-value'), false);
  assert.match(installs[0].files.userNpmrcEntry, /_authToken=deploy-token-value$/);

  assert.equal(client.calls[2][0], 'claim');
  assert.equal(client.calls[2][1], 'grant-secret');

  for (const secret of [...SECRETS, 'licence-secret']) {
    assert.equal(output.includes(secret), false, `${secret} leaked to the terminal`);
  }
  assert.match(output, /Bevestigingscode: ABCD-EFGH/);
});

test('a denied approval claims nothing and installs nothing', async () => {
  const client = stubClient({ pollStatuses: [{ status: 'denied' }] });
  let installed = false;

  await assert.rejects(
    runCreateTetra({
      argv: ['my-app'],
      cwd: '/tmp',
      version: '1.0.0',
      client,
      checkDirectory: async () => true,
      browser: () => {},
      write: () => {},
      sleep: async () => {},
      install: async () => { installed = true; },
    }),
    /geweigerd/,
  );

  assert.equal(installed, false);
  assert.equal(client.calls.some(([kind]) => kind === 'claim'), false);
});

test('an expired approval never reaches the claim', async () => {
  const client = stubClient({ pollStatuses: [{ status: 'expired' }] });

  await assert.rejects(
    runCreateTetra({
      argv: ['my-app'],
      cwd: '/tmp',
      version: '1.0.0',
      client,
      checkDirectory: async () => true,
      browser: () => {},
      write: () => {},
      sleep: async () => {},
      install: async () => {},
    }),
    /verlopen/,
  );

  assert.equal(client.calls.some(([kind]) => kind === 'claim'), false);
});

test('the browser is only opened for the approval URL the control plane gave', async () => {
  const opened = [];
  await runCreateTetra({
    argv: ['app'],
    cwd: '/tmp',
    version: '1.0.0',
    client: stubClient(),
    checkDirectory: async () => true,
    browser: (url) => opened.push(url),
    write: () => {},
    sleep: async () => {},
    install: async (o) => ({ projectPath: o.projectPath, projectName: o.projectName }),
  });

  assert.deepEqual(opened, ['https://www.tetrasaas.com/install/approve?request=public-id']);
});

test('a reserved prerelease still refuses before touching anything', async () => {
  let output = '';
  const client = stubClient();
  const run = await runCreateTetra({
    argv: [],
    version: '0.0.1-reserved.1',
    client,
    browser: () => { throw new Error('must not open a browser'); },
    write: (text) => { output += text; },
    install: async () => { throw new Error('must not install'); },
  });

  assert.equal(run.kind, 'unavailable');
  assert.equal(client.calls.length, 0);
  assert.match(output, /nog niet beschikbaar/);
});

test('an unusable target directory costs no approval and spends no grant', async () => {
  const client = stubClient();

  await assert.rejects(
    runCreateTetra({
      argv: ['taken'],
      cwd: '/tmp',
      version: '1.0.0',
      client,
      checkDirectory: async () => false,
      browser: () => { throw new Error('must not open a browser'); },
      write: () => {},
      sleep: async () => {},
      install: async () => { throw new Error('must not install'); },
    }),
    /bestaat al en is niet leeg/,
  );

  assert.deepEqual(client.calls, [], 'the control plane must not be contacted at all');
});

// basename is only the right thing to cd into when the project is a direct child
// of where the customer stands, and `npx create-tetra` without an argument is not.
test('the closing instructions point at a directory that exists', async () => {
  const { formatNextSteps } = await import('../src/scaffold.js');

  assert.equal(
    formatNextSteps({ projectPath: '/home/me/work', projectName: 'work' }, { cwd: '/home/me/work' })
      .includes('cd '),
    false,
    'there is nothing to cd into when the project is the current directory',
  );
  assert.match(
    formatNextSteps({ projectPath: '/home/me/work/my-app', projectName: 'my-app' }, { cwd: '/home/me/work' }),
    /cd my-app/,
  );
  assert.match(
    formatNextSteps({ projectPath: '/tmp/deep/nested/app', projectName: 'app' }, { cwd: '/tmp' }),
    /cd deep\/nested\/app/,
  );
});

// The scaffolder enforces kebab-case and does so after the single-use grant is
// already spent, so this has to be caught before the approval is requested.
test('an unusable project name costs no approval', async () => {
  const { projectNameProblem } = await import('../src/cli.js');

  for (const name of ['MyApp', 'my_app', 'Klant Demo', '2048', 'tetra.demo', '-app']) {
    assert.ok(projectNameProblem(name), `${name} must be rejected`);
  }
  for (const name of ['my-app', 'app', 'tetra-demo-2']) {
    assert.equal(projectNameProblem(name), null, `${name} must be accepted`);
  }

  const client = stubClient();
  await assert.rejects(
    runCreateTetra({
      argv: ['MyApp'],
      cwd: '/tmp',
      version: '1.0.0',
      client,
      checkDirectory: async () => true,
      browser: () => { throw new Error('must not open a browser'); },
      write: () => {},
      sleep: async () => {},
      install: async () => { throw new Error('must not install'); },
    }),
    /kleine letters, cijfers en streepjes/,
  );

  assert.deepEqual(client.calls, [], 'the control plane must not be contacted');
});

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
        verificationUri: 'https://tetrasaas.com/install/approve?request=public-id',
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
  assert.match(output, /Instructie voor AI-assistenten/);
  assert.match(output, /herstart dit commando niet/);
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

test('an expired approval with no renewals left never reaches the claim', async () => {
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
      maxRenewals: 0,
    }),
    /verlopen/,
  );

  assert.equal(client.calls.some(([kind]) => kind === 'claim'), false);
});

// The TTL (10 minutes) is shorter than the email round trip a human actually
// needs, which is exactly why the old hard stop on 'expired' was the loop
// Albert kept hitting: a renewal must pick up with a fresh code and still
// finish the install when the renewal itself gets approved.
test('an expired code is renewed automatically, and a later approval still installs', async () => {
  const client = stubClient({
    pollStatuses: [{ status: 'expired' }, { status: 'approved', installGrant: 'grant-secret' }],
  });
  const installed = [];

  const result = await runCreateTetra({
    argv: ['horeca-crm'],
    cwd: '/tmp',
    version: '1.0.0',
    client,
    checkDirectory: async () => true,
    browser: () => {},
    write: () => {},
    sleep: async () => {},
    install: async (options) => {
      installed.push(options);
      return { projectPath: options.projectPath, projectName: options.projectName };
    },
  });

  assert.equal(result.kind, 'installed');
  assert.equal(installed.length, 1);
  assert.equal(client.calls.filter(([kind]) => kind === 'authorize').length, 2);
  assert.equal(client.calls.filter(([kind]) => kind === 'poll').length, 2);
});

// Renewing has to stop eventually: an authorization nobody is ever going to
// approve must not poll the control plane forever.
test('renewals run out, and the final failure still says verlopen', async () => {
  const client = stubClient({
    pollStatuses: [{ status: 'expired' }, { status: 'expired' }, { status: 'expired' }],
  });

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
      install: async () => { throw new Error('must not install'); },
      maxRenewals: 2,
    }),
    /verlopen/,
  );

  assert.equal(client.calls.filter(([kind]) => kind === 'authorize').length, 3);
  assert.equal(client.calls.some(([kind]) => kind === 'claim'), false);
});

// A denial is final by design — unlike an expiry, nothing about it should be
// retried, so a renewal budget must not turn a "no" into another prompt.
test('a denial is never retried, even with renewals left in the budget', async () => {
  const client = stubClient({ pollStatuses: [{ status: 'denied' }] });

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
      install: async () => { throw new Error('must not install'); },
      maxRenewals: 4,
    }),
    /geweigerd/,
  );

  assert.equal(client.calls.filter(([kind]) => kind === 'authorize').length, 1);
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

  assert.deepEqual(opened, ['https://tetrasaas.com/install/approve?request=public-id']);
});

// openBrowser reports a missing opener through the write channel it is handed.
// Defaulting to stdout inside that function would bypass the CLI's own output,
// so the CLI has to pass its own — otherwise the notice is untestable here and
// unroutable everywhere else.
test('the browser opener gets the same output channel as the rest of the run', async () => {
  let output = '';
  let handed;
  await runCreateTetra({
    argv: ['app'],
    cwd: '/tmp',
    version: '1.0.0',
    client: stubClient(),
    checkDirectory: async () => true,
    browser: (_url, options) => { handed = options; },
    write: (text) => { output += text; },
    sleep: async () => {},
    install: async (o) => ({ projectPath: o.projectPath, projectName: o.projectName }),
  });

  assert.equal(typeof handed?.write, 'function', 'the CLI must hand the opener a write channel');
  handed.write('opener said something\n');
  assert.match(output, /opener said something/);
});

// installProject uses cwd for the in-cwd containment check and for the recovery
// command it prints. Both are wrong if the CLI does not pass its own.
test('the working directory reaches the installer instead of being rediscovered', async () => {
  let received;
  await runCreateTetra({
    argv: ['apps/my-app'],
    cwd: '/home/customer/projects',
    version: '1.0.0',
    client: stubClient(),
    checkDirectory: async () => true,
    browser: () => {},
    write: () => {},
    sleep: async () => {},
    install: async (options) => {
      received = options;
      return { projectPath: options.projectPath, projectName: options.projectName };
    },
  });

  assert.equal(received?.cwd, '/home/customer/projects');
  assert.equal(received?.projectPath, '/home/customer/projects/apps/my-app');
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

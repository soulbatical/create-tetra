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

// The TTL is no longer the 10 minutes that made a renewal the normal path: the
// control plane now issues a code that stays valid for hours, and the CLI must
// leave that one code alone until the server itself says it expired. A new code
// mid-run means a new link, a new code to compare, and a customer who has to
// look at the browser twice.
test('a valid code is never rotated, no matter how long the customer takes', async () => {
  const TTL_MS = 9 * 60 * 60_000;
  let clock = 0;
  const now = () => clock;
  const calls = [];
  const opened = [];
  let output = '';
  const client = {
    calls,
    async requestAuthorization() {
      calls.push(['authorize']);
      return {
        authorizationId: 'auth-id',
        deviceCode: 'device-secret',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://tetrasaas.com/install/approve?request=public-id',
        intervalSeconds: 60,
        expiresAt: now() + TTL_MS,
      };
    },
    async pollAuthorization() {
      calls.push(['poll']);
      // The customer only looks at the browser after almost nine hours.
      if (now() >= TTL_MS - 60_000) return { status: 'approved', installGrant: 'grant-secret' };
      return { status: 'pending' };
    },
    async claim() {
      return claim;
    },
  };

  const result = await runCreateTetra({
    argv: ['horeca-crm'],
    cwd: '/tmp',
    version: '1.0.0',
    client,
    checkDirectory: async () => true,
    browser: (url) => opened.push(url),
    write: (text) => { output += text; },
    sleep: async (ms) => { clock += ms; },
    now,
    install: async (options) => ({ projectPath: options.projectPath, projectName: options.projectName }),
  });

  assert.equal(result.kind, 'installed');
  assert.equal(calls.filter(([kind]) => kind === 'authorize').length, 1, 'the code must not be rotated');
  assert.equal(opened.length, 1, 'the same link is opened once');
  assert.equal((output.match(/Bevestigingscode: ABCD-EFGH/g) ?? []).length, 1);
  // The waiting line has to say how long the code is still good for.
  assert.match(output, /Geldig tot .*nog 9 uur/);
  assert.match(output, /Ik wacht tot .*nog 10 uur/);
  assert.match(output, /blijven geldig zolang de goedkeuring loopt/);
});

// An expired code is the one case where a renewal is allowed: the customer kept
// the old link open while it died, and asking again keeps the run alive.
test('an expired code is renewed, and a later approval still installs', async () => {
  const client = stubClient({
    pollStatuses: [{ status: 'expired' }, { status: 'approved', installGrant: 'grant-secret' }],
  });
  const installed = [];
  let output = '';

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
      installed.push(options);
      return { projectPath: options.projectPath, projectName: options.projectName };
    },
  });

  assert.equal(result.kind, 'installed');
  assert.equal(installed.length, 1);
  assert.equal(client.calls.filter(([kind]) => kind === 'authorize').length, 2);
  assert.match(output, /Deze code is verlopen/);
});

// A renewal count alone stopped being a useful bound once the TTL became hours:
// 4 renewals at 9 hours is two days. The bound is now the wall clock, and the
// run must stop exactly there with a message that describes what happened.
test('the wait is bounded at ten hours, and the final message says verlopen', async () => {
  const TTL_MS = 10 * 60_000;
  const BUDGET_MS = 10 * 60 * 60_000;
  let clock = 0;
  let currentExpiry = 0;
  const now = () => clock;
  const calls = [];
  let output = '';
  const client = {
    calls,
    async requestAuthorization() {
      calls.push(['authorize']);
      currentExpiry = now() + TTL_MS;
      return {
        authorizationId: 'auth-id',
        deviceCode: 'device-secret',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://tetrasaas.com/install/approve?request=public-id',
        intervalSeconds: 60,
        expiresAt: currentExpiry,
      };
    },
    async pollAuthorization() {
      calls.push(['poll']);
      return { status: now() >= currentExpiry ? 'expired' : 'pending' };
    },
  };

  await assert.rejects(
    runCreateTetra({
      argv: ['my-app'],
      cwd: '/tmp',
      version: '1.0.0',
      client,
      checkDirectory: async () => true,
      browser: () => {},
      write: (text) => { output += text; },
      sleep: async (ms) => { clock += ms; },
      now,
      install: async () => { throw new Error('must not install'); },
    }),
    (error) => {
      assert.match(error.message, /Verlopen/);
      assert.match(error.message, /10 uur/);
      assert.match(error.message, /niet verbruikt/);
      assert.match(error.message, /niets geïnstalleerd/);
      return true;
    },
  );

  assert.equal(clock, BUDGET_MS, 'the advertised ten hours is the actual bound');
  // One at the start and a renewal per ten-minute TTL, all inside the budget.
  assert.equal(calls.filter(([kind]) => kind === 'authorize').length, 60);
  assert.match(output, /Ik wacht tot .*nog 10 uur/);
});

// The deadline is a promise printed to the customer and to an AI assistant. A
// later renewal must not be able to extend it, however long the server makes
// its own TTL.
test('a renewal with a much longer TTL cannot extend the announced deadline', async () => {
  let clock = 0;
  const now = () => clock;
  let currentExpiry = 0;
  const calls = [];
  const client = {
    calls,
    async requestAuthorization() {
      calls.push(['authorize']);
      const ttlMs = calls.filter(([kind]) => kind === 'authorize').length === 1 ? 2 * 60_000 : 100 * 60 * 60_000;
      currentExpiry = now() + ttlMs;
      return {
        authorizationId: 'auth-id',
        deviceCode: 'device-secret',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://tetrasaas.com/install/approve?request=public-id',
        intervalSeconds: 60,
        expiresAt: currentExpiry,
      };
    },
    async pollAuthorization() {
      calls.push(['poll']);
      return { status: now() >= currentExpiry ? 'expired' : 'pending' };
    },
  };

  await assert.rejects(
    runCreateTetra({
      argv: ['my-app'],
      cwd: '/tmp',
      version: '1.0.0',
      client,
      checkDirectory: async () => true,
      browser: () => {},
      write: () => {},
      sleep: async (ms) => { clock += ms; },
      now,
      maxRenewals: 1,
      install: async () => { throw new Error('must not install'); },
    }),
    /Verlopen/,
  );

  assert.equal(clock, 10 * 60 * 60_000);
});

// Review round 2 measured that a poll blip outlasting the client's own ~1s
// retry window threw the whole run away, despite tens of minutes of renewal
// budget sitting unused. A poll is always safe to repeat, so a failure there
// should cost nothing more than the next interval.
function transientError(message) {
  const error = new Error(message);
  error.transient = true;
  return error;
}

test('a failed poll is treated like pending, not like a reason to give up', async () => {
  const pollOutcomes = [
    transientError('ECONNRESET'),
    transientError('ECONNRESET'),
    { status: 'approved', installGrant: 'grant-secret' },
  ];
  const client = stubClient();
  client.pollAuthorization = async (deviceCode) => {
    client.calls.push(['poll', deviceCode]);
    const next = pollOutcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  };

  const result = await runCreateTetra({
    argv: ['horeca-crm'],
    cwd: '/tmp',
    version: '1.0.0',
    client,
    checkDirectory: async () => true,
    browser: () => {},
    write: () => {},
    sleep: async () => {},
    install: async (options) => ({ projectPath: options.projectPath, projectName: options.projectName }),
  });

  assert.equal(result.kind, 'installed');
  assert.equal(client.calls.filter(([kind]) => kind === 'poll').length, 3);
  assert.equal(client.calls.filter(([kind]) => kind === 'authorize').length, 1);
});

// The counterpart to the test above: a poll failure that is NOT marked
// transient (a 404, or a contract violation like "unknown authorization
// status") is a real answer, not a blip. Review round 3 measured that
// swallowing it anyway silently polled for the entire renewal budget (tens
// of minutes) and then reported the generic "De goedkeuring is verlopen" —
// never showing the actual problem. It must surface on the first poll.
test('a non-transient poll failure surfaces immediately, not after the whole renewal budget', async () => {
  const client = stubClient();
  let polls = 0;
  client.pollAuthorization = async (deviceCode) => {
    polls += 1;
    client.calls.push(['poll', deviceCode]);
    const error = new Error('Control plane returned an unknown authorization status.');
    error.transient = false;
    throw error;
  };

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
    }),
    /unknown authorization status/,
  );

  assert.equal(polls, 1);
  assert.equal(client.calls.filter(([kind]) => kind === 'authorize').length, 1);
});

// claim() is never retried because it spends a single-use grant, so any
// failure there ends the run — but the customer (or the AI assistant reading
// this output) needs to be told that the approval is now spent and the fix
// is a fresh run, not a restart-and-wait.
test('a failed claim says the approval is spent, not just that something broke', async () => {
  const client = stubClient();
  client.claim = async () => { throw new Error('ECONNRESET'); };

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
    }),
    (error) => {
      assert.match(error.message, /Mislukt na goedkeuring/);
      assert.match(error.message, /kan niet opnieuw gebruikt worden/);
      assert.match(error.message, /opnieuw/);
      assert.match(error.message, /ECONNRESET/);
      assert.equal(error.cause?.message, 'ECONNRESET');
      return true;
    },
  );
});

// A denial is final by design — unlike an expiry, nothing about it should be
// retried, so a renewal budget must not turn a "no" into another prompt.
test('a denial is never retried, and the final state is geannuleerd', async () => {
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
    (error) => {
      assert.match(error.message, /Geannuleerd/);
      assert.match(error.message, /niet verbruikt/);
      assert.match(error.message, /niets geïnstalleerd/);
      return true;
    },
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
// already spent, so a name we cannot use has to be caught before the approval.
// What changed is where the name comes from: a directory is not a slug, and
// refusing `npx create-tetra .` in `dansschool.crm` made the customer rename his
// own folder. Derive a slug and say so; --name is the explicit override.
async function runCapturingName(argv, { cwd = '/tmp' } = {}) {
  let output = '';
  let requested;
  const client = stubClient();
  const requestAuthorization = client.requestAuthorization.bind(client);
  client.requestAuthorization = async (input) => {
    requested = input;
    return requestAuthorization(input);
  };

  const result = await runCreateTetra({
    argv,
    cwd,
    version: '1.0.0',
    client,
    checkDirectory: async () => true,
    browser: () => {},
    write: (text) => { output += text; },
    sleep: async () => {},
    install: async (options) => ({ projectPath: options.projectPath, projectName: options.projectName }),
  });

  return { result, output, requested, client };
}

test('a directory name with dots gets a slug, and the CLI shows which', async () => {
  const { requested, output } = await runCapturingName(['dansschool.crm']);

  assert.equal(requested.project.name, 'dansschool-crm');
  assert.match(output, /Project: dansschool-crm \(afgeleid van de mapnaam "dansschool\.crm"\)/);
});

test('underscores, spaces, accents and a leading digit still produce a usable slug', async () => {
  for (const [directory, slug] of [
    ['Mijn_CRM', 'mijn-crm'],
    ['Klant Demo', 'klant-demo'],
    ['Café Crème', 'cafe-creme'],
    ['2048', 'app-2048'],
    ['v1.2.3', 'v1-2-3'],
  ]) {
    const { requested, output } = await runCapturingName([directory]);
    assert.equal(requested.project.name, slug, `${directory} should become ${slug}`);
    assert.match(output, /afgeleid van de mapnaam/);
  }
});

test('--name overrides the directory name, in both spellings', async () => {
  for (const argv of [
    ['dansschool.crm', '--name', 'crm-dansschool'],
    ['dansschool.crm', '--name=crm-dansschool'],
  ]) {
    const { requested, output } = await runCapturingName(argv);
    assert.equal(requested.project.name, 'crm-dansschool');
    assert.equal(output.includes('afgeleid van de mapnaam'), false, 'an explicit name is not derived');
  }
});

test('an unusable --name costs no approval', async () => {
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
      argv: ['MyApp', '--name', 'MyApp'],
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

test('a name that cannot even be derived names --name instead of dead-ending', async () => {
  const client = stubClient();
  await assert.rejects(
    runCreateTetra({
      argv: ['...'],
      cwd: '/tmp',
      version: '1.0.0',
      client,
      checkDirectory: async () => true,
      browser: () => { throw new Error('must not open a browser'); },
      write: () => {},
      sleep: async () => {},
      install: async () => { throw new Error('must not install'); },
    }),
    (error) => {
      assert.match(error.message, /--name/);
      return true;
    },
  );

  assert.deepEqual(client.calls, [], 'the control plane must not be contacted');
});

// The second-machine route is a CLI command, not a paragraph in a README the
// customer reads only after the E404. These pin the wiring: the command runs,
// its report reaches the terminal, and a failing doctor is a failing exit.
test('--doctor prints the diagnosis and reports whether the machine is usable', async () => {
  let output = '';
  const seen = [];
  const result = await runCreateTetra({
    argv: ['--doctor'],
    cwd: '/projects/my-app',
    version: '1.0.0',
    credentials: {
      doctor: async (options) => {
        seen.push(options);
        return { ok: false, report: 'GEEN TOKEN\n' };
      },
    },
    write: (text) => { output += text; },
  });

  assert.deepEqual(seen, [{ projectPath: '/projects/my-app' }]);
  assert.equal(result.kind, 'doctor');
  assert.equal(result.ok, false);
  assert.match(output, /GEEN TOKEN/);
});

test('--doctor can be pointed at another project directory', async () => {
  const seen = [];
  await runCreateTetra({
    argv: ['--doctor', '/projects/other'],
    cwd: '/home/me',
    version: '1.0.0',
    credentials: {
      doctor: async (options) => { seen.push(options); return { ok: true, report: '' }; },
    },
    write: () => {},
  });

  assert.deepEqual(seen, [{ projectPath: '/projects/other' }]);
});

test('--export-credentials and --import-credentials pass the resolved file through', async () => {
  const exported = [];
  await runCreateTetra({
    argv: ['--export-credentials', 'tetra-credentials.json', '/projects/my-app'],
    cwd: '/home/me',
    version: '1.0.0',
    credentials: {
      export: async (options) => { exported.push(options); return { destination: options.destination, authKey: '//x/' }; },
    },
    write: () => {},
  });
  assert.deepEqual(exported, [{ projectPath: '/projects/my-app', destination: '/home/me/tetra-credentials.json' }]);

  const imported = [];
  await runCreateTetra({
    argv: ['--import-credentials', 'tetra-credentials.json'],
    cwd: '/home/me',
    version: '1.0.0',
    credentials: {
      import: async (options) => { imported.push(options); return { path: '/home/me/.npmrc', authKey: '//x/' }; },
    },
    write: () => {},
  });
  assert.deepEqual(imported, [{ source: '/home/me/tetra-credentials.json' }]);
});

test('a credential command without a file says what is missing', async () => {
  for (const argv of [['--export-credentials'], ['--import-credentials']]) {
    await assert.rejects(
      runCreateTetra({ argv, version: '1.0.0', write: () => {} }),
      /bestand/,
    );
  }
});

test('--help names the new options and how long the approval stays valid', async () => {
  let output = '';
  await runCreateTetra({ argv: ['--help'], version: '1.0.0', write: (text) => { output += text; } });

  for (const expected of ['--name', '--doctor', '--export-credentials', '--import-credentials']) {
    assert.ok(output.includes(expected), `--help must mention ${expected}`);
  }
  assert.match(output, /9 uur/);
  assert.match(output, /10 uur/);
  assert.match(output, /niet opnieuw te starten|niet opnieuw starten/);
});

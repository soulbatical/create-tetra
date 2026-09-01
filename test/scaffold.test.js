import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureEnvIsIgnored, installProject, storeRegistryCredential } from '../src/scaffold.js';

const AUTH_KEY = '//gitlab.example/npm/';

const files = {
  projectNpmrc: '@soulbatical:registry=https://gitlab.example/npm/\nengine-strict=true\n',
  userNpmrcEntry: `${AUTH_KEY}:_authToken=deploy-token-value`,
  env: 'TETRA_LICENSE_KEY=licence\nNPM_TOKEN=deploy-token-value\n',
  token: 'deploy-token-value',
  authKey: AUTH_KEY,
};

function harness({ scaffolderWrites = null, directoryFree = true } = {}) {
  const writes = [];
  const execs = [];
  const removedDirectories = [];
  const modes = [];
  const stored = [];
  return {
    writes,
    execs,
    removedDirectories,
    modes,
    stored,
    options: {
      projectPath: '/projects/my-app',
      projectName: 'my-app',
      files,
      write: () => {},
      checkDirectory: async () => directoryFree,
      makeTempDirectory: async () => '/tmp/tool',
      makeDirectory: async (path, options) => { modes.push({ call: 'mkdir', path, options }); },
      setMode: async (path, mode) => { modes.push({ call: 'chmod', path, mode }); },
      writeProjectFile: async (path, content, options) => { writes.push({ path, content, options }); },
      removeFile: async () => {},
      removeDirectory: async (path) => { removedDirectories.push(path); },
      ignoreEnv: async () => {},
      storeCredential: async (given) => { stored.push(given); return '/home/customer/.npmrc'; },
      // The real scaffolder writes its own maintainer-facing .npmrc while it
      // generates, so reproduce that here: it is exactly the write our own has
      // to land after.
      exec: async (command, args, options) => {
        execs.push({ command, args, options });
        if (command.includes('create-soulbatical-app') && scaffolderWrites) writes.push(scaffolderWrites);
        return { stdout: '', stderr: '' };
      },
    },
  };
}

const projectWrites = (h, name) => h.writes.filter(({ path }) => path === `/projects/my-app/${name}`);

test("the customer's registry is written after the scaffolder, not before", async () => {
  const h = harness({
    scaffolderWrites: {
      path: '/projects/my-app/.npmrc',
      content: '@soulbatical:registry=https://npm.pkg.github.com\n',
    },
  });

  await installProject(h.options);

  const last = projectWrites(h, '.npmrc').at(-1);
  assert.match(last.content, /gitlab\.example/);
  assert.equal(
    last.content.includes('npm.pkg.github.com'),
    false,
    'the maintainer registry must not survive as the final .npmrc',
  );
});

// npm does not read .env, so a project .npmrc that only names ${NPM_TOKEN} makes
// every later `npm install` fail with a bare 401.
test('the credential is stored where npm looks for it, not only in .env', async () => {
  const h = harness();
  await installProject(h.options);

  assert.deepEqual(h.stored, [files]);
  const npmrc = projectWrites(h, '.npmrc').at(-1);
  assert.equal(npmrc.content.includes('_authToken'), false);
  assert.equal(npmrc.content.includes('deploy-token-value'), false);
});

test('the project install runs before we claim the project is ready', async () => {
  const h = harness();
  await installProject(h.options);

  const scaffoldIndex = h.execs.findIndex(({ command }) => command.includes('create-soulbatical-app'));
  const installIndex = h.execs.findIndex(
    ({ command, args, options }) => command === 'npm' && args[0] === 'install' && options.cwd === '/projects/my-app',
  );

  assert.ok(installIndex >= 0, 'a project-level npm install must have run');
  assert.ok(installIndex > scaffoldIndex, 'the install must come after the scaffold');
});

// Removed and recreated exclusively: writeFile leaves the mode of an existing
// file alone, and 'wx' fails on a planted symlink instead of writing through it.
test('every file carrying a credential is created exclusively with a private mode', async () => {
  const h = harness();
  await installProject(h.options);

  const secretFiles = h.writes.filter(({ path }) => path.endsWith('.npmrc') || path.endsWith('.env'));
  assert.ok(secretFiles.length >= 3);
  for (const { path, options } of secretFiles) {
    assert.equal(options?.mode, 0o600, `${path} must be 0600`);
    assert.equal(options?.flag, 'wx', `${path} must be created exclusively`);
  }
});

// mkdir leaves the mode of an existing directory alone, and an existing empty
// directory is a valid target.
test('the project directory is locked down even when it already existed', async () => {
  const h = harness();
  await installProject(h.options);

  assert.equal(h.modes.find(({ call }) => call === 'mkdir').options.mode, 0o700);
  assert.deepEqual(
    h.modes.find(({ call }) => call === 'chmod'),
    { call: 'chmod', path: '/projects/my-app', mode: 0o700 },
  );
});

test('the helper install lives outside the project, ignores scripts and is cleaned up', async () => {
  const h = harness();
  await installProject(h.options);

  assert.deepEqual(h.removedDirectories, ['/tmp/tool']);
  const helper = h.execs.find(({ args }) => args.includes('@soulbatical/create-app'));
  assert.ok(helper.args.includes('--ignore-scripts'), 'lifecycle scripts must not run for the helper install');
  assert.equal(helper.args[helper.args.indexOf('--prefix') + 1], '/tmp/tool');
  assert.equal(h.writes.some(({ path }) => path.startsWith('/projects/my-app/node_modules')), false);
});

test('a non-empty target directory stops everything before any command runs', async () => {
  const h = harness({ directoryFree: false });
  await assert.rejects(installProject(h.options), /bestaat al en is niet leeg/);
  assert.equal(h.execs.length, 0);
  assert.equal(h.writes.length, 0);
});

test('the helper directory is cleaned up even when the scaffolder fails', async () => {
  const h = harness();
  h.options.exec = async (command) => {
    if (command.includes('create-soulbatical-app')) throw new Error('scaffolder crashed');
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(installProject(h.options), /scaffolder crashed/);
  assert.deepEqual(h.removedDirectories, ['/tmp/tool']);
});

// The credential now lives in the user config, so the project install has to be
// able to read it. Running it with the tool config would shield it from exactly
// the file we just wrote.
test('the project install uses the real user config, not the tool config', async () => {
  const h = harness();
  await installProject(h.options);

  const projectInstall = h.execs.find(
    ({ command, args, options }) => command === 'npm' && args[0] === 'install' && options.cwd === '/projects/my-app',
  );
  assert.equal(
    projectInstall.options.env.NPM_CONFIG_USERCONFIG,
    process.env.NPM_CONFIG_USERCONFIG,
    'the project install must not be pointed at the throwaway tool config',
  );

  const helper = h.execs.find(({ args }) => args.includes('@soulbatical/create-app'));
  assert.equal(helper.options.env.NPM_CONFIG_USERCONFIG, '/tmp/tool/.npmrc');
});

// The default 1 MB buffer makes a chatty install reject after it succeeded, and
// the customer is told it failed.
test('the project install is not allowed to fail on its own output', async () => {
  const h = harness();
  await installProject(h.options);

  const projectInstall = h.execs.find(
    ({ command, args, options }) => command === 'npm' && args[0] === 'install' && options.cwd === '/projects/my-app',
  );
  assert.ok(projectInstall.options.maxBuffer > 1024 * 1024, 'the default buffer is too small for an install');
  assert.ok(projectInstall.options.timeout > 0, 'a hung install must not hang the CLI forever');
});

test('.env is added to .gitignore exactly once', async () => {
  const written = [];
  await ensureEnvIsIgnored('/projects/my-app', {
    read: async () => 'node_modules\n.env\n',
    write: async (p, c) => written.push({ p, c }),
  });
  assert.equal(written.length, 0, 'already ignored, nothing to do');

  await ensureEnvIsIgnored('/projects/my-app', {
    read: async () => 'node_modules',
    write: async (p, c) => written.push({ p, c }),
  });
  assert.equal(written.at(-1).c, 'node_modules\n.env\n');
});

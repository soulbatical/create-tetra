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
      storeCredential: async (given, options = {}) => {
        stored.push({ files: given, path: options.path });
        return options.path ?? '/home/customer/.npmrc';
      },
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

  assert.deepEqual(h.stored.map(({ files: given }) => given), [files]);
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
  await installProject({ ...h.options, resolveUserConfig: () => ({ path: '/home/customer/.npmrc', ignored: null }) });

  const projectInstall = h.execs.find(
    ({ command, args, options }) => command === 'npm' && args[0] === 'install' && options.cwd === '/projects/my-app',
  );
  assert.equal(
    projectInstall.options.env.NPM_CONFIG_USERCONFIG,
    '/home/customer/.npmrc',
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

// The final install sits past the point of no return: the grant is spent and the
// directory is no longer empty, so a bare failure leaves the customer stuck.
test('a failed dependency install leaves a recoverable project, not a dead end', async () => {
  const h = harness();
  let output = '';
  h.options.write = (text) => { output += text; };
  const original = h.options.exec;
  h.options.exec = async (command, args, options) => {
    if (command === 'npm' && args[0] === 'install' && options.cwd === '/projects/my-app') {
      throw Object.assign(new Error('Command failed: npm install'), { killed: true, signal: 'SIGTERM' });
    }
    return original(command, args, options);
  };

  const result = await installProject(h.options);

  assert.equal(result.installed, false);
  assert.match(output, /Het project staat in \/projects\/my-app/);
  assert.match(output, /langer dan 15 minuten/);
  assert.match(output, /cd \/projects\/my-app && npm install/);
});

// storeCredential sits at the same place as the dependency install: the grant is
// spent and the project is generated. A missing parent directory is the likely
// cause and is created, but a symlink loop or a read-only home is not fixable
// from here — and a raw throw there is the dead end B18 was built to avoid.
test('a credential that cannot be stored leaves a diagnosable project, not a stack trace', async () => {
  const h = harness();
  let output = '';
  h.options.write = (text) => { output += text; };
  h.options.storeCredential = async () => {
    throw new Error('/home/customer/.npmrc is een symlink die na 10 stappen nog steeds naar een symlink wijst.');
  };

  const result = await installProject(h.options);

  assert.equal(result.installed, false, 'nothing may claim this project is ready to run');
  assert.match(output, /Het project staat in \/projects\/my-app/);
  assert.match(output, /symlink/, 'the reason has to reach the customer');
  assert.equal(
    h.execs.some(({ command, args, options }) => command === 'npm' && args[0] === 'install' && options.cwd === '/projects/my-app'),
    false,
    'installing dependencies without a stored token only produces a 401',
  );
  assert.equal(h.removedDirectories.includes('/tmp/tool'), true, 'the helper directory is still cleaned up');
  assert.equal(output.includes('deploy-token-value'), false, 'the recovery message must not print the token');
  // Recovery needs a fresh approval, and installProject refuses a directory that
  // is not empty -- which this one now is. Telling him to just rerun would walk
  // him into that refusal.
  assert.match(output, /verwijder die projectmap of kies een andere naam/);
  assert.equal(/cd .*npm install/.test(output), false, 'npm install without a token only produces a 401');
});

test('the closing message does not contradict the recovery instructions', async () => {
  const { formatNextSteps } = await import('../src/scaffold.js');
  assert.equal(
    formatNextSteps({ projectPath: '/p/app', projectName: 'app', installed: false }, { cwd: '/p' }),
    '',
  );
  assert.match(
    formatNextSteps({ projectPath: '/p/app', projectName: 'app', installed: true }, { cwd: '/p' }),
    /npm run dev/,
  );
});

// npx resolves npm's own config for the directory the customer happened to be
// standing in — a project .npmrc there can set `userconfig=` — and hands the
// result to us as npm_config_* variables. Passing those straight through means
// npm reads a file chosen by that directory instead of the one we just stored
// the credential in. Measured against a local registry: the install goes out
// with no Authorization header at all.
test('the project install reads the npmrc the token was actually stored in', async () => {
  const h = harness();
  await installProject({
    ...h.options,
    environment: {
      PATH: '/usr/bin',
      npm_config_userconfig: '/hostile/repo/collected.npmrc',
      npm_config_registry: 'http://evil.example/npm/',
    },
    resolveUserConfig: () => ({ path: '/home/customer/.npmrc', ignored: null }),
  });

  const projectInstall = h.execs.find(
    ({ command, args, options }) => command === 'npm' && args[0] === 'install' && options.cwd === '/projects/my-app',
  );
  assert.equal(
    projectInstall.options.env.NPM_CONFIG_USERCONFIG,
    '/home/customer/.npmrc',
    'the install must be pointed at the file the credential was written to',
  );
  assert.deepEqual(
    h.stored.map(({ path }) => path),
    ['/home/customer/.npmrc'],
    'and the credential must go to that same resolved path',
  );
});

test('npm config inherited from npx cannot steer either install', async () => {
  const h = harness();
  await installProject({
    ...h.options,
    environment: {
      PATH: '/usr/bin',
      npm_config_userconfig: '/hostile/repo/collected.npmrc',
      npm_config_registry: 'http://evil.example/npm/',
      NPM_CONFIG_REGISTRY: 'http://evil.example/npm/',
    },
    resolveUserConfig: () => ({ path: '/home/customer/.npmrc', ignored: null }),
  });

  for (const { command, args, options } of h.execs) {
    const inherited = Object.keys(options.env).filter(
      (key) => /^npm_config_/i.test(key) && key !== 'NPM_CONFIG_USERCONFIG',
    );
    assert.deepEqual(inherited, [], `${command} ${args[0]} inherited npm config: ${inherited.join(', ')}`);
    assert.equal(options.env.PATH, '/usr/bin', 'the rest of the environment must survive');
  }

  const helper = h.execs.find(({ args }) => args.includes('@soulbatical/create-app'));
  assert.equal(helper.options.env.NPM_CONFIG_USERCONFIG, '/tmp/tool/.npmrc');
});

// A userconfig we refuse to use changes where npm looks for the token, so the
// customer has to be told; otherwise the install fails with a bare 401 later.
test('a userconfig we will not follow is reported instead of silently dropped', async () => {
  const h = harness();
  const said = [];
  await installProject({
    ...h.options,
    write: (text) => said.push(text),
    resolveUserConfig: () => ({
      path: '/home/customer/.npmrc',
      ignored: { value: './collected.npmrc', reason: 'relative' },
    }),
  });

  const notice = said.join('');
  assert.match(notice, /NPM_CONFIG_USERCONFIG/, 'name the setting being ignored');
  assert.match(notice, /\.\/collected\.npmrc/, 'and the value, so it can be found');
});

// libuv terminates a timed-out process on Windows without a term signal, so
// requiring SIGTERM reports a timeout as an ordinary failure there.
test('a timeout is reported as a timeout regardless of platform', async () => {
  const h = harness();
  const said = [];
  const timedOut = Object.assign(new Error('Command failed: npm install'), { killed: true, signal: null });
  const result = await installProject({
    ...h.options,
    write: (text) => said.push(text),
    exec: async (command, args, options) => {
      h.execs.push({ command, args, options });
      if (command === 'npm' && args[0] === 'install' && options.cwd === '/projects/my-app') throw timedOut;
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.installed, false);
  assert.match(said.join(''), /15 minuten/);
});

// `Command failed: npm install` tells the customer nothing. npm puts the real
// reason — 401, ERESOLVE, ENOTFOUND — on stderr.
test('the reason npm gave is passed on, not the generic wrapper', async () => {
  const h = harness();
  const said = [];
  const failed = Object.assign(new Error('Command failed: npm install'), {
    killed: false,
    signal: null,
    stderr: 'npm error code E401\nnpm error Unable to authenticate, need: Bearer\n\n',
  });
  await installProject({
    ...h.options,
    write: (text) => said.push(text),
    exec: async (command, args, options) => {
      h.execs.push({ command, args, options });
      if (command === 'npm' && args[0] === 'install' && options.cwd === '/projects/my-app') throw failed;
      return { stdout: '', stderr: '' };
    },
  });

  const notice = said.join('');
  assert.match(notice, /Unable to authenticate/);
  assert.doesNotMatch(notice, /\(Command failed: npm install\)/);
});

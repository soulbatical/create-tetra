import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureEnvIsIgnored, formatNextSteps, installProject, storeRegistryCredential } from '../src/scaffold.js';

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

// Fetching the scaffolder sits past the point of no return just like the
// dependency install does -- the grant is spent before installProject is even
// called. A broken npm cache, a full disk or a proxy in the way is the ordinary
// way this fails, and execFile puts the whole command line plus all of npm's
// stderr into error.message, so the customer got that wall of text and no word
// about his approval being gone.
test('a failed scaffolder fetch is reported, not dumped', async () => {
  const h = harness();
  h.options.exec = async (command, args) => {
    if (command === 'npm' && args.includes('@soulbatical/create-app')) {
      throw Object.assign(
        new Error([
          'Command failed: npm install --no-save --no-package-lock --ignore-scripts --prefix /tmp/tool @soulbatical/create-app',
          'npm error code ENOSPC',
          'npm error nospc ENOSPC: no space left on device, write',
        ].join('\n')),
        { stderr: 'npm error code ENOSPC\nnpm error nospc ENOSPC: no space left on device, write\n', code: 1 },
      );
    }
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(installProject(h.options), (error) => {
    // The reason npm actually gave, not the generic wrapper (N16).
    assert.match(error.message, /no space left on device/, 'the real reason has to survive');
    assert.equal(
      error.message.includes('Command failed:'),
      false,
      'the echoed command line is noise the customer cannot act on',
    );
    assert.match(error.message, /goedkeuring/, 'he has to hear that the approval is spent');
    assert.match(error.message, /npx create-tetra/, 'and how to start over');
    assert.equal(/^\s+at /m.test(error.message), false, 'no stack frames');
    return true;
  });

  assert.deepEqual(h.removedDirectories, ['/tmp/tool'], 'the helper directory is still cleaned up');
});

// The generate step is the same class one line down: same position, same raw
// failure, only by then the project directory exists and has to be mentioned.
test('a failed scaffolder run is reported, not dumped', async () => {
  const h = harness();
  h.options.exec = async (command) => {
    if (command.includes('create-soulbatical-app')) {
      throw Object.assign(new Error('Command failed: create-soulbatical-app'), {
        stderr: 'Error: template registry unreachable\n',
      });
    }
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(installProject(h.options), (error) => {
    assert.match(error.message, /template registry unreachable/);
    assert.equal(error.message.includes('Command failed:'), false);
    assert.match(error.message, /goedkeuring/);
    assert.match(error.message, /\/projects\/my-app/, 'the directory that now exists has to be named');
    return true;
  });

  assert.deepEqual(h.removedDirectories, ['/tmp/tool']);
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

// The recovery command has to recreate the project where it was asked for. The
// basename is only that when the project is a direct child of where the customer
// stands -- `npx create-tetra apps/my-app` would come back as `my-app` and land
// the retry in the wrong directory. formatNextSteps already uses the relative
// path for its `cd`; the same value is the right one here.
test('the recovery command points back at the path the customer asked for', async () => {
  for (const [projectPath, cwd, expected] of [
    ['/projects/my-app', '/projects', 'npx create-tetra my-app'],
    ['/projects/apps/my-app', '/projects', 'npx create-tetra apps/my-app'],
    ['/projects/my-app', '/projects/my-app', 'npx create-tetra'],
    // Unquoted this reads as two arguments, and parseArgs answers "Geef maximaal
    // een project-map op." -- so the recovery advice would fail on its own.
    ['/projects/my dir/app', '/projects', 'npx create-tetra "my dir/app"'],
  ]) {
    const h = harness();
    let output = '';
    h.options.write = (text) => { output += text; };
    h.options.storeCredential = async () => { throw new Error('geen bestand om te schrijven'); };

    await installProject({ ...h.options, projectPath, cwd });

    assert.ok(
      output.includes(expected),
      `expected "${expected}" for ${projectPath} from ${cwd}, got:\n${output}`,
    );
  }
});

test('the closing message does not contradict the recovery instructions', () => {
  assert.equal(
    formatNextSteps({ projectPath: '/p/app', projectName: 'app', installed: false }, { cwd: '/p' }),
    '',
  );
  assert.match(
    formatNextSteps({ projectPath: '/p/app', projectName: 'app', installed: true }, { cwd: '/p' }),
    /npm run dev:local/,
  );
});

// The last thing the customer is told to do, and the one command he will
// actually run. `npm run dev` is `doppler run -- npm run dev:all` in the
// scaffolded project, so from a fresh install it fails on a missing Doppler
// binary, or -- if he happens to have one -- on "You must specify a project".
// `npm run dev:local` is the path that works from nothing, and the generated
// README already draws that line. Asserted on the exact step line, because a
// substring match on "npm run dev" cannot tell the two apart.
test('the closing message starts the customer on the path that works from nothing', () => {
  const lines = formatNextSteps(
    { projectPath: '/home/c/demo-app', projectName: 'demo-app', installed: true },
    { cwd: '/home/c' },
  ).split('\n');
  const steps = lines.filter((line) => line.startsWith('  ') && line.trim() !== '');

  assert.deepEqual(steps, ['  cd demo-app', '  npm run dev:local']);
  assert.equal(
    steps.includes('  npm run dev'),
    false,
    'npm run dev needs Doppler and cannot be the first command a fresh customer runs',
  );

  const prose = lines.filter((line) => !line.startsWith('  ')).join('\n');
  assert.match(prose, /Supabase/, 'say what dev:local needs before he finds out from a script');
  // Both, because dev-local.sh only checks that Supabase is running: without the
  // reset the command starts and the app has no schema, which moves the stumble
  // rather than removing it.
  assert.match(prose, /supabase start/, 'and name the command that provides it');
  assert.match(prose, /supabase db reset/, 'including the one that gives the app its schema');
  assert.match(prose, /Doppler/, 'say what npm run dev is for, so the script name is not a mystery');
  assert.match(prose, /npm run dev\b/, 'and name it, since that is the other half of the choice');
  assert.match(prose, /README/, 'the rest belongs in the project, not in this message');
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
// The in-cwd rule is a security check, so it has to run against the directory
// installProject was actually given rather than whatever process.cwd() happens
// to be. Calling resolveConfig() bare makes the cwd parameter decorative.
test('the userconfig check runs against the working directory it was given', async () => {
  const h = harness();
  const seen = [];
  await installProject({
    ...h.options,
    cwd: '/home/customer/projects',
    resolveUserConfig: (options) => {
      seen.push(options);
      return { path: '/home/customer/.npmrc', ignored: null };
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.cwd, '/home/customer/projects', 'the containment check must see the real cwd');
});

test('a userconfig we will not follow is reported instead of silently dropped', async () => {
  // Every reason resolveUserConfig can return needs a sentence behind it. A new
  // reason with no text renders as "undefined", which is worse than silence.
  for (const [value, reason] of [
    ['./collected.npmrc', 'relative'],
    ['/work/repo/collected.npmrc', 'in-cwd'],
    ['/etc/npmrc', 'outside-home'],
    ['C:\\Users\\c\\mine.npmrc', 'win32'],
  ]) {
    const h = harness();
    const said = [];
    await installProject({
      ...h.options,
      write: (text) => said.push(text),
      resolveUserConfig: () => ({ path: '/home/customer/.npmrc', ignored: { value, reason } }),
    });

    const notice = said.join('');
    assert.match(notice, /NPM_CONFIG_USERCONFIG/, 'name the setting being ignored');
    assert.ok(notice.includes(value), 'and the value, so it can be found');
    assert.match(notice, /\/home\/customer\/\.npmrc/, 'and where the token goes instead');
    assert.equal(notice.includes('undefined'), false, `reason ${reason} has no sentence behind it`);
  }
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

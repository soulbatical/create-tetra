import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveUserConfig, resolveUserConfigPath, storeRegistryCredential } from '../src/scaffold.js';

const AUTH_KEY = '//gitlab.example/api/v4/projects/1/packages/npm/';
const files = { authKey: AUTH_KEY, token: 'new-token' };

async function scratch() {
  return mkdtemp(join(tmpdir(), 'create-tetra-npmrc-'));
}

// Stubbed filesystems hide exactly the failures that matter here, so this file
// uses a real one: this is the customer's own npmrc, not a file we own.
test('other registries survive, and the stale entry for ours does not', async () => {
  const dir = await scratch();
  const path = join(dir, '.npmrc');
  await writeFile(path, [
    '@other:registry=https://other.example/',
    '//other.example/:_authToken=keep-me',
    `${AUTH_KEY}:_authToken=stale`,
    'engine-strict=true',
    '',
  ].join('\n'));

  try {
    const written = await storeRegistryCredential(files, { path });
    const content = await readFile(written, 'utf8');

    assert.match(content, /\/\/other\.example\/:_authToken=keep-me/);
    assert.match(content, /engine-strict=true/);
    assert.equal(content.includes('stale'), false);
    assert.equal(content.match(/gitlab\.example/g).length, 1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// npm accepts the key with and without a trailing slash and prefers the slash
// form, so a leftover slashless entry would silently outrank what we write.
test('a stale entry in the other slash form is removed too', async () => {
  const dir = await scratch();
  const path = join(dir, '.npmrc');
  await writeFile(path, `${AUTH_KEY.replace(/\/$/, '')}:_authToken=stale-noslash\n`);

  try {
    const content = await readFile(await storeRegistryCredential(files, { path }), 'utf8');
    assert.equal(content.includes('stale-noslash'), false);
    assert.equal(content.match(/gitlab\.example/g).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A symlinked npmrc points into a dotfiles repository. Replacing the link would
// detach the customer from their own config management without saying so.
test('a symlinked npmrc is written through, not replaced', async () => {
  const dir = await scratch();
  const real = join(dir, 'dotfiles-npmrc');
  const link = join(dir, '.npmrc');
  await writeFile(real, '//other.example/:_authToken=keep-me\n');
  await symlink(real, link);

  try {
    const written = await storeRegistryCredential(files, { path: link });

    assert.equal((await lstat(link)).isSymbolicLink(), true, 'the symlink must survive');
    assert.equal(written, real, 'the link target is what was written');
    const content = await readFile(real, 'utf8');
    assert.match(content, /keep-me/);
    assert.match(content, /new-token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The replacement is atomic: there is no window in which the file is missing,
// and a failed write must leave the customer's credentials intact.
test('a failed write leaves the original npmrc untouched', async () => {
  const dir = await scratch();
  const path = join(dir, '.npmrc');
  const original = '//other.example/:_authToken=irreplaceable\n';
  await writeFile(path, original);

  try {
    await assert.rejects(
      storeRegistryCredential(files, {
        path,
        write: async () => { throw Object.assign(new Error('ENOSPC simulated'), { code: 'ENOSPC' }); },
      }),
      /ENOSPC/,
    );

    assert.equal(await readFile(path, 'utf8'), original, 'the original must still be there, unchanged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no leftover temp file after a successful write', async () => {
  const dir = await scratch();
  const path = join(dir, '.npmrc');
  await writeFile(path, '');

  try {
    await storeRegistryCredential(files, { path });
    await assert.rejects(stat(`${path}.create-tetra-${process.pid}`), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing npmrc is created with just our entry', async () => {
  const dir = await scratch();
  const path = join(dir, '.npmrc');

  try {
    const content = await readFile(await storeRegistryCredential(files, { path }), 'utf8');
    assert.equal(content, `${AUTH_KEY}:_authToken=new-token\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// npm reads the userconfig the environment points at, not necessarily the one in
// the home directory. Guessing writes a token into a file npm never reads.
// Deliberately not via `npm config get userconfig`: that resolution honours a
// project .npmrc, which would let whatever repository the customer stands in
// decide where their personal registry token is written.
test('an explicit userconfig from the customer is honoured', () => {
  assert.equal(
    resolveUserConfigPath({
      env: { NPM_CONFIG_USERCONFIG: '/home/c/elsewhere/custom-npmrc' },
      home: '/home/c',
      fallback: '/home/c/.npmrc',
      cwd: '/work',
    }),
    '/home/c/elsewhere/custom-npmrc',
  );
});

// npx injects npm_config_userconfig itself, already absolute, using a resolution
// that honours `userconfig=` from a project .npmrc. Reading the lowercase form
// would hand the placement of a personal token to whatever repo the customer
// happens to stand in.
test('the lowercase variable npx injects is ignored', () => {
  assert.equal(
    resolveUserConfigPath({
      env: { npm_config_userconfig: '/work/hostile-repo/collected.npmrc' },
      home: '/home/c',
      fallback: '/home/c/.npmrc',
      cwd: '/work/hostile-repo',
    }),
    '/home/c/.npmrc',
  );
});

// The case above is caught twice over: the containment rules would refuse that
// path even if the lowercase variable were read, so on its own it does not pin
// the precedence down. `userconfig=../outside/collected.npmrc` in the project
// .npmrc makes npm resolve to somewhere absolute, outside the repository, and a
// hostile repository is free to aim that at the customer's own home directory.
// Nothing but reading the uppercase name alone rejects this one, so this is the
// test that fails if line 57 is ever "tidied up" back into a `??` chain.
test('the lowercase variable is ignored even where no containment rule would catch it', () => {
  const resolved = resolveUserConfig({
    env: { npm_config_userconfig: '/home/c/.config/attacker/collected.npmrc' },
    home: '/home/c',
    fallback: '/home/c/.npmrc',
    cwd: '/work/hostile-repo',
  });

  // Absolute, outside cwd, and inside home: every guard other than the name
  // itself says yes to this path.
  assert.equal(resolved.path, '/home/c/.npmrc');
  assert.equal(resolved.ignored, null, 'a variable we never read is not a setting we refuse');
});

// Windows environment lookups are case-insensitive, so the two variables cannot
// be told apart there. A userconfig inside the working directory is never a real
// user-level config, which is what makes containment the right guard.
test('a userconfig inside the working directory is refused', () => {
  for (const [configured, cwd] of [
    ['/home/c/work/repo/collected.npmrc', '/home/c/work/repo'],
    ['/home/c/work/repo/nested/deep.npmrc', '/home/c/work/repo'],
  ]) {
    assert.equal(
      resolveUserConfigPath({
        env: { NPM_CONFIG_USERCONFIG: configured },
        home: '/home/c',
        fallback: '/home/c/.npmrc',
        cwd,
      }),
      '/home/c/.npmrc',
      `expected ${configured} to be refused from ${cwd}`,
    );
  }
  assert.equal(
    resolveUserConfigPath({
      env: { NPM_CONFIG_USERCONFIG: '/home/c/work/repo-sibling/.npmrc' },
      home: '/home/c',
      fallback: '/home/c/.npmrc',
      cwd: '/home/c/work/repo',
    }),
    '/home/c/work/repo-sibling/.npmrc',
    'a sibling directory is not containment',
  );
});

// The other half of that guard, and the half Windows actually needs. A hostile
// project .npmrc does not have to point inside itself: `userconfig=../outside/x`
// makes npm resolve to an absolute path next to the repository, which clears
// both the isAbsolute check and the in-cwd rule. On win32 process.env lookups
// are case-insensitive, so npx's injected value arrives under the uppercase
// name and there is nothing left to tell it apart from the customer's own
// setting -- except that a real user-level config lives under the home
// directory and this does not.
test('a userconfig outside the home directory is refused', () => {
  for (const configured of [
    '/work/npxprobe/outside/collected.npmrc', // the reviewed measurement: sibling of the repo
    '/tmp/attacker/collected.npmrc',
    '/etc/npmrc',
  ]) {
    const resolved = resolveUserConfig({
      env: { NPM_CONFIG_USERCONFIG: configured },
      home: '/home/c',
      fallback: '/home/c/.npmrc',
      cwd: '/work/npxprobe/repo',
    });
    assert.equal(resolved.path, '/home/c/.npmrc', `expected ${configured} to be refused`);
    assert.deepEqual(
      resolved.ignored,
      { value: configured, reason: 'outside-home' },
      'refusing it silently would leave npm reading a different file than the customer configured',
    );
  }
});

// The guard is a boundary, not a blanket refusal: the home directory itself and
// anything under it stays honoured, or a customer who moved his npmrc on purpose
// would silently stop being followed.
test('a userconfig under the home directory is still honoured', () => {
  for (const configured of [
    '/home/c/.npmrc',
    '/home/c/mine.npmrc',
    '/home/c/.config/npm/npmrc',
  ]) {
    const resolved = resolveUserConfig({
      env: { NPM_CONFIG_USERCONFIG: configured },
      home: '/home/c',
      fallback: '/home/c/.npmrc',
      cwd: '/work/repo',
    });
    assert.equal(resolved.path, configured, `expected ${configured} to be honoured`);
    assert.equal(resolved.ignored, null);
  }
});

test('a relative or empty userconfig falls back instead of following the working directory', () => {
  for (const env of [
    {},
    { NPM_CONFIG_USERCONFIG: '' },
    { NPM_CONFIG_USERCONFIG: '   ' },
    { NPM_CONFIG_USERCONFIG: './collected.npmrc' },
    { NPM_CONFIG_USERCONFIG: '../sneaky.npmrc' },
  ]) {
    assert.equal(
      resolveUserConfigPath({ env, fallback: '/home/customer/.npmrc', cwd: '/work' }),
      '/home/customer/.npmrc',
      `expected ${JSON.stringify(env)} to fall back`,
    );
  }
});

// A repository the customer merely cloned must not be able to redirect where
// their personal token lands.
//
// The environment matters more than the chdir here. npx does not hand the child
// a clean env: it resolves `userconfig=` from the project .npmrc it found in the
// working directory and injects the answer as an absolute `npm_config_userconfig`.
// A hand-built `{}` proves only that an empty environment falls back, which is
// not the case the hostile repository exercises — so run the real shape too.
test('a project .npmrc cannot redirect the token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-npmrc-'));
  // The home directory has to sit outside the repository, or the containment
  // assertion below would be testing the fixture instead of the code.
  const outside = await mkdtemp(join(tmpdir(), 'create-tetra-home-'));
  const previous = process.cwd();
  await writeFile(join(dir, '.npmrc'), 'userconfig=./collected.npmrc\n');
  const collected = join(dir, 'collected.npmrc');

  const environments = [
    // What npx actually passes: npm's own resolution of the project .npmrc,
    // already absolute, so an isAbsolute guard never sees anything suspicious.
    ['npx injects npm\'s resolution', { npm_config_userconfig: collected }],
    // Both forms at once: npm reads `/^npm_config_/i`, so the lowercase one must
    // not win just because it is also present.
    ['both cases present', { npm_config_userconfig: collected, NPM_CONFIG_USERCONFIG: collected }],
    // The real environment, so an ambient injection would show up here rather
    // than being defined away by a hand-built object.
    ['the ambient environment', undefined],
  ];

  try {
    process.chdir(dir);
    const home = join(outside, '.npmrc');

    for (const [label, env] of environments) {
      const written = await storeRegistryCredential(files, {
        resolvePath: () => resolveUserConfigPath({ ...(env ? { env } : {}), fallback: home, cwd: dir }),
      });

      // The property is containment, not a specific path: CI sets its own
      // NPM_CONFIG_USERCONFIG, so asserting equality with the fallback would test
      // the runner instead of the code. What must hold everywhere is that nothing
      // the repository points at can pull the token inside it.
      assert.equal(
        written.startsWith(`${dir}/`),
        false,
        `${label}: the token must not land inside the repository (${written})`,
      );
      await assert.rejects(stat(collected), { code: 'ENOENT' }, `${label}: nothing may be written into the repository`);
    }
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// Dotfiles that are not checked out yet leave a dangling link, and replacing it
// detaches the customer from their own config management just the same.
test('a dangling symlink is followed, not replaced by a regular file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-npmrc-'));
  const missing = join(dir, 'not-yet-checked-out');
  const link = join(dir, '.npmrc');
  await symlink(missing, link);

  try {
    const written = await storeRegistryCredential(files, { path: link });

    assert.equal((await lstat(link)).isSymbolicLink(), true, 'the symlink must survive');
    assert.equal(written, missing);
    assert.match(await readFile(missing, 'utf8'), /new-token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// readlink resolves one level. A chain would leave the middle link replaced by a
// regular file and the real content out of the effective config.
test('a chain of symlinks is followed to the end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-npmrc-'));
  const real = join(dir, 'real-npmrc');
  const mid = join(dir, 'mid-npmrc');
  const top = join(dir, '.npmrc');
  await writeFile(real, '//other.example/:_authToken=keep-me\n');
  await symlink(real, mid);
  await symlink(mid, top);

  try {
    const written = await storeRegistryCredential(files, { path: top });

    assert.equal(written, real, 'the end of the chain is what gets written');
    assert.equal((await lstat(top)).isSymbolicLink(), true);
    assert.equal((await lstat(mid)).isSymbolicLink(), true, 'the middle link must survive too');
    const content = await readFile(real, 'utf8');
    assert.match(content, /keep-me/);
    assert.match(content, /new-token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A cap that only stops the walk still writes the token somewhere arbitrary --
// the last link in the loop -- and replaces that link with a regular file. A loop
// is broken configuration with no correct target, so it has to say so.
test('a loop of symlinks ends in a clear error, not a hang or a replaced link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-npmrc-'));
  const top = join(dir, '.npmrc');
  const other = join(dir, 'looped-npmrc');
  await symlink(other, top);
  await symlink(top, other);

  try {
    await assert.rejects(
      storeRegistryCredential(files, { path: top }),
      (error) => {
        assert.match(error.message, /symlink/i, 'the message must name the cause');
        assert.ok(error.message.includes(top), 'the message must name the path the customer has to fix');
        return true;
      },
    );

    assert.equal((await lstat(top)).isSymbolicLink(), true, 'neither link may be replaced');
    assert.equal((await lstat(other)).isSymbolicLink(), true);
    await assert.rejects(stat(`${top}.create-tetra-${process.pid}`), { code: 'ENOENT' }, 'no temp file may be left');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The cap is there for loops, not to put a ceiling on how someone may arrange
// their dotfiles. A chain that ends must still be followed to its end.
test('a chain just short of the cap is still followed to the end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-npmrc-'));
  const real = join(dir, 'real-npmrc');
  await writeFile(real, '//other.example/:_authToken=keep-me\n');

  let previous = real;
  for (let step = 0; step < 9; step += 1) {
    const link = join(dir, `link-${step}`);
    await symlink(previous, link);
    previous = link;
  }

  try {
    const written = await storeRegistryCredential(files, { path: previous });
    assert.equal(written, real, 'the end of the chain is what gets written');
    assert.match(await readFile(real, 'utf8'), /keep-me/);
    assert.match(await readFile(real, 'utf8'), /new-token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// "Dotfiles not checked out yet" usually means the whole directory is missing,
// and a raw ENOENT here strands the customer after the grant is already spent.
test('a symlink into a directory that does not exist yet still works', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-npmrc-'));
  const missing = join(dir, 'dotfiles', 'not', 'cloned', '.npmrc');
  const link = join(dir, '.npmrc');
  await symlink(missing, link);

  try {
    const written = await storeRegistryCredential(files, { path: link });
    assert.equal(written, missing);
    assert.match(await readFile(missing, 'utf8'), /new-token/);
    assert.equal((await lstat(link)).isSymbolicLink(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Silently falling back changes which file npm reads for credentials. The
// customer needs to hear it, or the install fails later with a bare 401 and
// nothing pointing at the cause.
test('a userconfig we refuse to follow says so, and says which one', () => {
  const settings = { home: '/home/customer', fallback: '/home/customer/.npmrc', cwd: '/work' };

  for (const [configured, reason] of [
    ['./collected.npmrc', 'relative'],
    ['/work/repo/collected.npmrc', 'in-cwd'],
    ['/etc/npmrc', 'outside-home'],
  ]) {
    const resolved = resolveUserConfig({ ...settings, env: { NPM_CONFIG_USERCONFIG: configured } });
    assert.equal(resolved.path, '/home/customer/.npmrc');
    assert.deepEqual(resolved.ignored, { value: configured, reason }, `expected ${configured} to report ${reason}`);
  }

  assert.equal(
    resolveUserConfig({ ...settings, env: { NPM_CONFIG_USERCONFIG: '/home/customer/mine.npmrc' } }).ignored,
    null,
    'a usable setting is not a complaint',
  );
});

// npm's own parseField expands `~\\` on win32; only handling `~/` leaves a
// Windows customer's setting silently dropped.
test('a home-relative userconfig is expanded the way npm expands it', () => {
  assert.equal(
    resolveUserConfigPath({
      env: { NPM_CONFIG_USERCONFIG: '~/mine.npmrc' },
      home: '/home/customer',
      cwd: '/work',
      platform: 'linux',
    }),
    '/home/customer/mine.npmrc',
  );

  assert.equal(
    resolveUserConfigPath({
      env: { NPM_CONFIG_USERCONFIG: '~\\sub\\mine.npmrc' },
      home: '/home/customer',
      cwd: '/work',
      platform: 'win32',
    }),
    join('/home/customer', 'sub\\mine.npmrc'),
    'a backslash form is home-relative on Windows',
  );
});

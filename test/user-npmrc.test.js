import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveUserConfigPath, storeRegistryCredential } from '../src/scaffold.js';

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
test('the userconfig path comes from the environment, never from the working directory', () => {
  assert.equal(
    resolveUserConfigPath({ env: { NPM_CONFIG_USERCONFIG: '/elsewhere/custom-npmrc' }, fallback: '/home/c/.npmrc' }),
    '/elsewhere/custom-npmrc',
  );
  assert.equal(
    resolveUserConfigPath({ env: { npm_config_userconfig: '/lower/custom-npmrc' }, fallback: '/home/c/.npmrc' }),
    '/lower/custom-npmrc',
  );
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
      resolveUserConfigPath({ env, fallback: '/home/customer/.npmrc' }),
      '/home/customer/.npmrc',
      `expected ${JSON.stringify(env)} to fall back`,
    );
  }
});

// A repository the customer merely cloned must not be able to redirect where
// their personal token lands.
test('a project .npmrc cannot redirect the token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-npmrc-'));
  const previous = process.cwd();
  await writeFile(join(dir, '.npmrc'), 'userconfig=./collected.npmrc\n');

  try {
    process.chdir(dir);
    const home = join(dir, 'home-npmrc');
    const written = await storeRegistryCredential(files, {
      resolvePath: () => resolveUserConfigPath({ env: {}, fallback: home }),
    });

    assert.equal(written, home);
    await assert.rejects(stat(join(dir, 'collected.npmrc')), { code: 'ENOENT' });
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
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

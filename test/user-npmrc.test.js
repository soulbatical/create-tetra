import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
    assert.equal(written, await realpath(real), 'the resolved target is what was written');
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
test('the userconfig path comes from npm, not from a guess', async () => {
  const resolved = await resolveUserConfigPath({
    exec: async (command, args) => {
      assert.equal(command, 'npm');
      assert.deepEqual(args, ['config', 'get', 'userconfig']);
      return { stdout: '/elsewhere/custom-npmrc\n', stderr: '' };
    },
    fallback: '/home/customer/.npmrc',
  });
  assert.equal(resolved, '/elsewhere/custom-npmrc');
});

test('the home directory is only the fallback when npm cannot answer', async () => {
  for (const exec of [
    async () => { throw new Error('npm missing'); },
    async () => ({ stdout: '\n', stderr: '' }),
    async () => ({ stdout: 'undefined\n', stderr: '' }),
  ]) {
    assert.equal(
      await resolveUserConfigPath({ exec, fallback: '/home/customer/.npmrc' }),
      '/home/customer/.npmrc',
    );
  }
});

// An indented _authToken line is active config, so the trim in the filter is
// load-bearing rather than cosmetic.
test('an indented stale entry is removed too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-npmrc-'));
  const path = join(dir, '.npmrc');
  await writeFile(path, `   ${AUTH_KEY}:_authToken=stale-indented\n`);

  try {
    const content = await readFile(await storeRegistryCredential(files, { path }), 'utf8');
    assert.equal(content.includes('stale-indented'), false);
    assert.equal(content.match(/gitlab\.example/g).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Without an explicit path this must ask npm where the userconfig is, not assume
// the home directory: guessing writes the token into a file npm never reads.
test('without an explicit path the userconfig is resolved, not assumed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-npmrc-'));
  const resolved = join(dir, 'resolved-npmrc');
  let asked = false;

  try {
    const written = await storeRegistryCredential(files, {
      resolvePath: async () => { asked = true; return resolved; },
    });

    assert.equal(asked, true, 'the userconfig path must be resolved, not guessed');
    assert.equal(written, resolved, 'the resolved path is where the token lands');
    assert.match(await readFile(resolved, 'utf8'), /new-token/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

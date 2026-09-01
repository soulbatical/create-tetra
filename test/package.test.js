import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('public package has no pre-auth dependencies and points at public source', () => {
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org');
  assert.equal(pkg.publishConfig.provenance, true);
  assert.equal(pkg.repository.url, 'git+https://github.com/soulbatical/create-tetra.git');
});

test('packed tarball starts in a clean shell without private registry config', () => {
  const target = mkdtempSync(join(tmpdir(), 'create-tetra-clean-shell-'));
  try {
    const cleanEnv = {
      ...process.env,
      NPM_TOKEN: '',
      NODE_AUTH_TOKEN: '',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_CACHE: join(target, 'npm-cache'),
    };
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', target], {
      cwd: root,
      encoding: 'utf8',
      env: cleanEnv,
    }));
    const tarball = join(target, packed[0].filename);
    execFileSync('npm', ['install', '--ignore-scripts', '--no-package-lock', '--prefix', target, tarball], {
      stdio: 'pipe',
      env: cleanEnv,
    });
    const help = execFileSync(join(target, 'node_modules', '.bin', 'create-tetra'), ['--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    assert.match(help, /npx create-tetra@latest/);
    assert.doesNotMatch(help, /--yes/);

    const bin = join(target, 'node_modules', '.bin', 'create-tetra');
    const reserved = spawnSync(bin, [], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(reserved.status, 1);
    assert.match(reserved.stdout, /nog niet beschikbaar/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

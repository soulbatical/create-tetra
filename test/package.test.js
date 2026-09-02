import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isReservedRelease } from '../src/cli.js';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('public package has no pre-auth dependencies and points at public source', () => {
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org');
  assert.equal(pkg.publishConfig.provenance, true);
  assert.equal(pkg.repository.url, 'git+https://github.com/soulbatical/create-tetra.git');
});

// The refusal guard in cli.js runs before everything else, so a prerelease
// version in package.json means the published artifact declines to install
// anything at all. That is correct while the name is only reserved and fatal the
// moment it is not: publish.yml bumps nothing -- the dist-tag follows the type of
// GitHub Release, the version comes from this file -- so a real release of a
// prerelease version either fails as already-published or ships the refusal under
// `next`.
//
// Asserted as the property rather than as the behaviour. The version and the
// guard have to agree, and this holds that after a bump exactly as it did
// before, instead of turning red and inviting someone to delete the guardrail
// that made the refusal mean something.
test('the shipped version and the refusal guard cannot drift apart', () => {
  assert.equal(
    isReservedRelease(pkg.version),
    false,
    `version ${pkg.version} is a prerelease, so the published CLI would refuse to run`,
  );
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
    assert.match(help, /npx create-tetra/);
    assert.doesNotMatch(help, /--yes/);

    // This used to assert that running the binary bare refuses with the reserved
    // notice. It does not any more, and the property test above is what replaced
    // it: the refusal is now a function of the version rather than a fact about
    // the artifact. Running it bare here would reach the control plane, so what
    // stays checkable offline is that the installed binary reports the version it
    // was packed from -- the value the guard reads and the dist-tag is chosen by.
    const bin = join(target, 'node_modules', '.bin', 'create-tetra');
    const reported = spawnSync(bin, ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(reported.status, 0);
    assert.equal(reported.stdout.trim(), pkg.version);
    assert.doesNotMatch(reported.stdout, /nog niet beschikbaar/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

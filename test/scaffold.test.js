import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import { ensureEnvIsIgnored, installProject } from '../src/scaffold.js';

const files = {
  npmrc: '@soulbatical:registry=https://gitlab.example/npm/\n//gitlab.example/npm/:_authToken=${NPM_TOKEN}\n',
  env: 'NPM_TOKEN=deploy-token-value\nTETRA_LICENSE_KEY=licence\n',
  token: 'deploy-token-value',
};

function harness({ scaffolderWrites = null, existing = true } = {}) {
  const writes = [];
  const execs = [];
  const removed = [];
  return {
    writes,
    execs,
    removed,
    options: {
      projectPath: '/projects/my-app',
      projectName: 'my-app',
      files,
      write: () => {},
      checkDirectory: async () => existing,
      makeTempDirectory: async () => '/tmp/tool',
      makeDirectory: async () => {},
      writeProjectFile: async (path, content) => {
        writes.push({ path, content });
      },
      removeDirectory: async (path) => { removed.push(path); },
      removeFile: async () => {},
      ignoreEnv: async () => {},
      // The real scaffolder writes its own maintainer-facing .npmrc while it
      // generates, so reproduce that here: it is exactly the write our own
      // write has to land after.
      exec: async (command, args) => {
        execs.push({ command, args });
        if (command.includes('create-soulbatical-app') && scaffolderWrites) {
          writes.push(scaffolderWrites);
        }
        return { stdout: '', stderr: '' };
      },
    },
  };
}

test("the customer's registry is written after the scaffolder, not before", async () => {
  const maintainerNpmrc = {
    path: '/projects/my-app/.npmrc',
    content: '@soulbatical:registry=https://npm.pkg.github.com\n',
  };
  const h = harness({ scaffolderWrites: maintainerNpmrc });

  await installProject(h.options);

  const projectNpmrcWrites = h.writes.filter(({ path }) => path === '/projects/my-app/.npmrc');
  assert.ok(projectNpmrcWrites.length >= 1, 'the project .npmrc must be written');

  const last = projectNpmrcWrites.at(-1);
  assert.match(last.content, /gitlab\.example/);
  assert.equal(
    last.content.includes('npm.pkg.github.com'),
    false,
    'the maintainer registry must not survive as the final .npmrc',
  );
});

test('the token never lands in the project .npmrc, only in .env', async () => {
  const h = harness();
  await installProject(h.options);

  for (const { path, content } of h.writes) {
    if (path.endsWith('.npmrc')) {
      assert.equal(content.includes('deploy-token-value'), false, `${path} contains the raw token`);
    }
  }
  const env = h.writes.find(({ path }) => path === '/projects/my-app/.env');
  assert.match(env.content, /deploy-token-value/);
});

test('the helper install lives outside the project and is cleaned up', async () => {
  const h = harness();
  await installProject(h.options);

  assert.deepEqual(h.removed, ['/tmp/tool']);
  const installStep = h.execs.find(({ command }) => command === 'npm');
  assert.ok(installStep.args.includes('--prefix'));
  assert.equal(installStep.args[installStep.args.indexOf('--prefix') + 1], '/tmp/tool');
  assert.equal(
    h.writes.some(({ path }) => path.startsWith('/projects/my-app/node_modules')),
    false,
  );
});

test('a non-empty target directory stops everything before any command runs', async () => {
  const h = harness({ existing: false });
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
  assert.deepEqual(h.removed, ['/tmp/tool']);
});

test('.env is added to .gitignore exactly once', async () => {
  const written = [];
  const read = async () => 'node_modules\n.env\n';
  await ensureEnvIsIgnored('/projects/my-app', { read, write: async (p, c) => written.push({ p, c }) });
  assert.equal(written.length, 0, 'already ignored, nothing to do');

  const readWithout = async () => 'node_modules';
  await ensureEnvIsIgnored('/projects/my-app', { read: readWithout, write: async (p, c) => written.push({ p, c }) });
  assert.equal(written.length, 1);
  assert.equal(written[0].c, 'node_modules\n.env\n');

  const missing = async () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };
  await ensureEnvIsIgnored('/projects/my-app', { read: missing, write: async (p, c) => written.push({ p, c }) });
  assert.equal(written.at(-1).c, '.env\n');
  assert.equal(written.at(-1).p, join('/projects/my-app', '.gitignore'));
});

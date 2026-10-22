import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CREDENTIALS_FILE_KIND,
  exportRegistryCredentials,
  findRegistryCredential,
  importRegistryCredentials,
  registryDoctor,
} from '../src/credentials.js';

const REGISTRY = 'https://gitlab.com/api/v4/projects/85262758/packages/npm/';
const AUTH_KEY = '//gitlab.com/api/v4/projects/85262758/packages/npm/';
const TOKEN = 'glpat-deploy-token-value';

const projectNpmrc = `@soulbatical:registry=${REGISTRY}\nengine-strict=true\n`;
const userNpmrc = `//registry.npmjs.org/:_authToken=npm-public\n${AUTH_KEY}:_authToken=${TOKEN}\n`;

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project');
  await mkdir(project);
  await writeFile(join(project, '.npmrc'), projectNpmrc);
  const userConfig = join(dir, 'first-machine.npmrc');
  await writeFile(userConfig, userNpmrc);
  return { dir, project, userConfig };
}

test('finds the token for one registry and ignores the placeholder', () => {
  const content = [
    '//npm.pkg.github.com/:_authToken=ghp-other',
    `${AUTH_KEY}:_authToken=${TOKEN}`,
  ].join('\n');

  assert.equal(findRegistryCredential(content, AUTH_KEY), TOKEN);
  assert.equal(findRegistryCredential(content, AUTH_KEY.replace(/\/$/, '')), TOKEN);
  assert.equal(findRegistryCredential(content, '//gitlab.com/api/v4/projects/1/packages/npm/'), null);
  assert.equal(findRegistryCredential('//gitlab.com/:_authToken=${NPM_TOKEN}', '//gitlab.com/'), null);
  assert.equal(findRegistryCredential('//gitlab.com/:_authToken=', '//gitlab.com/'), null);
});

test('exports the token to a private file that can be imported on a second machine', async (t) => {
  const { dir, project, userConfig } = await workspace(t);
  const destination = join(dir, 'tetra-credentials.json');

  const exported = await exportRegistryCredentials({
    projectPath: project,
    destination,
    userConfigPath: userConfig,
  });

  assert.equal(exported.authKey, AUTH_KEY);
  const document = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(document.kind, CREDENTIALS_FILE_KIND);
  assert.equal(document.version, 1);
  assert.deepEqual(document.registry, { auth_key: AUTH_KEY, token: TOKEN });
  assert.equal((await stat(destination)).mode & 0o777, 0o600, 'the exported file is a secret');

  const secondMachine = join(dir, 'second-machine.npmrc');
  const imported = await importRegistryCredentials({ source: destination, userConfigPath: secondMachine });

  assert.equal(imported.authKey, AUTH_KEY);
  assert.equal(imported.path, secondMachine);
  const written = await readFile(secondMachine, 'utf8');
  assert.match(written, new RegExp(`${AUTH_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:_authToken=${TOKEN}`));
  assert.equal((await stat(secondMachine)).mode & 0o777, 0o600);
});

// Exporting from a plain directory has no registry to look for, and guessing one
// from the allowlist could hand over the token for a different package registry.
test('export refuses to guess which registry to export', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const userConfig = join(dir, 'first-machine.npmrc');
  await writeFile(userConfig, userNpmrc);

  await assert.rejects(
    exportRegistryCredentials({
      projectPath: join(dir, 'no-project'),
      destination: join(dir, 'out.json'),
      userConfigPath: userConfig,
    }),
    (error) => {
      assert.match(error.message, /Geen \.npmrc/);
      assert.match(error.message, /--export-credentials/);
      return true;
    },
  );
});

test('export names the missing token and the doctor instead of writing an empty file', async (t) => {
  const { dir, project } = await workspace(t);
  const emptyUserConfig = join(dir, 'empty.npmrc');
  await writeFile(emptyUserConfig, '//registry.npmjs.org/:_authToken=npm-public\n');

  await assert.rejects(
    exportRegistryCredentials({
      projectPath: project,
      destination: join(dir, 'out.json'),
      userConfigPath: emptyUserConfig,
    }),
    (error) => {
      assert.match(error.message, /Geen registry-token/);
      assert.match(error.message, /--doctor/);
      assert.equal(error.message.includes(TOKEN), false, 'a diagnostic may not echo the token');
      return true;
    },
  );
});

test('import refuses files that could point the token somewhere else', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const cases = [
    [{ kind: 'something-else', version: 1, registry: { auth_key: AUTH_KEY, token: TOKEN } }, /create-tetra-credentials/],
    [{ kind: CREDENTIALS_FILE_KIND, version: 1, registry: { auth_key: '//evil.example/npm/', token: TOKEN } }, /onverwachte host/],
    [{ kind: CREDENTIALS_FILE_KIND, version: 1, registry: { auth_key: AUTH_KEY, token: 'two\nlines' } }, /token/],
    [{ kind: CREDENTIALS_FILE_KIND, version: 1, registry: { auth_key: AUTH_KEY, token: '${NPM_TOKEN}' } }, /placeholder/],
    [{ kind: CREDENTIALS_FILE_KIND, version: 1, registry: { auth_key: AUTH_KEY } }, /token/],
  ];

  for (const [document, expected] of cases) {
    const source = join(dir, `case-${Math.random().toString(16).slice(2)}.json`);
    await writeFile(source, JSON.stringify(document));
    await assert.rejects(
      importRegistryCredentials({ source, userConfigPath: join(dir, 'user.npmrc') }),
      expected,
    );
  }
});

test('a malformed credentials file is rejected without echoing its contents', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'broken.json');
  await writeFile(source, `{"kind":"${CREDENTIALS_FILE_KIND}","registry":{"token":"${TOKEN}"`);

  await assert.rejects(
    importRegistryCredentials({ source, userConfigPath: join(dir, 'user.npmrc') }),
    (error) => {
      assert.match(error.message, /niet lezen/);
      assert.ok(error.message.includes(source));
      assert.equal(error.message.includes(TOKEN), false, 'a parse error may quote its input');
      return true;
    },
  );
});

test('export refuses a project registry outside the hosts we ship from', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, 'project');
  await mkdir(project);
  await writeFile(join(project, '.npmrc'), '@soulbatical:registry=https://evil.example/npm/\n');
  const userConfig = join(dir, 'first-machine.npmrc');
  await writeFile(userConfig, '//evil.example/npm/:_authToken=borrowed-token\n');

  await assert.rejects(
    exportRegistryCredentials({
      projectPath: project,
      destination: join(dir, 'out.json'),
      userConfigPath: userConfig,
    }),
    /onverwachte host/,
  );
});

test('the doctor turns E404 into the missing line and the transfer route', async (t) => {
  const { dir, project } = await workspace(t);
  const emptyUserConfig = join(dir, 'second-machine.npmrc');
  await writeFile(emptyUserConfig, '//registry.npmjs.org/:_authToken=npm-public\n');
  await writeFile(join(project, 'ci.npmrc'), 'placeholder');

  const report = await registryDoctor({ projectPath: project, userConfigPath: emptyUserConfig });

  assert.equal(report.ok, false);
  assert.equal(report.authKey, AUTH_KEY);
  assert.match(report.report, /E404 Project not found/);
  assert.match(report.report, /geen auth-fout/i);
  assert.match(report.report, /--export-credentials/);
  assert.match(report.report, /--import-credentials/);
  assert.match(report.report, /--doctor/);
  assert.ok(report.report.includes(emptyUserConfig), 'name the file that was read');
  assert.equal(report.report.includes(TOKEN), false, 'the doctor must not print a token');
});

test('the doctor passes when the registry line is present', async (t) => {
  const { project, userConfig } = await workspace(t);
  const report = await registryDoctor({ projectPath: project, userConfigPath: userConfig });

  assert.equal(report.ok, true);
  assert.match(report.report, /Registry-token gevonden/);
  assert.ok(report.report.includes(AUTH_KEY));
  assert.equal(report.report.includes(TOKEN), false);
});

test('a literal ${NPM_TOKEN} in the user config counts as missing', async (t) => {
  const { dir, project } = await workspace(t);
  const userConfig = join(dir, 'placeholder.npmrc');
  await writeFile(userConfig, `${AUTH_KEY}:_authToken=\${NPM_TOKEN}\n`);

  const report = await registryDoctor({ projectPath: project, userConfigPath: userConfig });
  assert.equal(report.ok, false);
  assert.match(report.report, /E404 Project not found/);
});

test('the doctor explains that it has to run in the project', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'create-tetra-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const report = await registryDoctor({ projectPath: dir, userConfigPath: join(dir, 'user.npmrc') });
  assert.equal(report.ok, false);
  assert.match(report.report, /Geen \.npmrc/);
  assert.match(report.report, /--export-credentials/);
});

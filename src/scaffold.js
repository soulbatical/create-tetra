import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SCAFFOLDER = '@soulbatical/create-app';
const SCAFFOLDER_BIN = 'create-soulbatical-app';

export const directoryInUse = (path) => `De map ${path} bestaat al en is niet leeg.`;

export async function directoryIsFree(path) {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

async function writeSecretFile(path, content, { write: writeImpl = writeFile, remove = rm } = {}) {
  // The mode of an existing file is not changed by writeFile, and these carry a
  // credential. Remove first, then create exclusively: 'wx' is O_CREAT|O_EXCL,
  // which fails loudly on a file or a planted symlink rather than writing
  // through one, and a fresh file does take the mode.
  await remove(path, { force: true });
  await writeImpl(path, content, { mode: 0o600, flag: 'wx' });
}

// npm reads the userconfig the environment points at, which is not necessarily
// the one in the home directory. Guessing gets it wrong for anyone who sets
// NPM_CONFIG_USERCONFIG: we would write a token into a file npm never reads and
// then report success.
export async function resolveUserConfigPath({ exec = run, fallback = join(homedir(), '.npmrc') } = {}) {
  try {
    const { stdout } = await exec('npm', ['config', 'get', 'userconfig'], { env: process.env });
    const path = String(stdout).trim();
    return path === '' || path === 'undefined' ? fallback : path;
  } catch {
    return fallback;
  }
}

// This is the one file create-tetra touches that it does not own. It may hold
// the customer's npmjs login and every other registry they use, so it is
// replaced atomically: a temp file in the same directory, then a rename. There
// is no moment where the file does not exist, and a failed write leaves the
// original untouched.
async function replaceUserFile(path, content, { write: writeImpl = writeFile, move = rename, remove = rm } = {}) {
  const temporary = `${path}.create-tetra-${process.pid}`;
  try {
    await remove(temporary, { force: true });
    await writeImpl(temporary, content, { mode: 0o600, flag: 'wx' });
    await move(temporary, path);
  } finally {
    await remove(temporary, { force: true });
  }
}

// npm looks for credentials in the user-level npmrc, so that is where they go.
// Only the entry for this registry is replaced; everything else is preserved.
export async function storeRegistryCredential(
  { authKey, token },
  {
    path,
    read = readFile,
    write: writeImpl = writeFile,
    remove = rm,
    move = rename,
    resolveLink = realpath,
    resolvePath = resolveUserConfigPath,
  } = {},
) {
  const configured = path ?? (await resolvePath());

  // A symlinked npmrc usually points into a dotfiles repository. Replacing the
  // link would silently detach the customer from their own config management,
  // so write through to whatever it resolves to instead.
  let target = configured;
  try {
    target = await resolveLink(configured);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let current = '';
  try {
    current = await read(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  // npm accepts the key with or without a trailing slash and prefers the
  // trailing-slash form when both exist, so a stale entry in the other form
  // would outrank what we write. Remove both.
  const stale = [authKey, authKey.replace(/\/$/, '')].map((key) => `${key}:_authToken=`);
  const kept = current
    .split('\n')
    .filter((line) => !stale.some((prefix) => line.trim().startsWith(prefix)));
  while (kept.length > 0 && kept.at(-1).trim() === '') kept.pop();
  kept.push(`${authKey}:_authToken=${token}`, '');

  await replaceUserFile(target, kept.join('\n'), { write: writeImpl, move, remove });
  return target;
}

async function ensureEnvIsIgnored(projectPath, { read = readFile, write: writeImpl = writeFile } = {}) {
  const path = join(projectPath, '.gitignore');
  let current = '';
  try {
    current = await read(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current.split('\n').some((line) => line.trim() === '.env')) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeImpl(path, `${current}${separator}.env\n`);
}

export async function installProject({
  projectPath,
  projectName,
  files,
  write,
  exec = run,
  makeDirectory = mkdir,
  makeTempDirectory = mkdtemp,
  setMode = chmod,
  writeProjectFile = writeFile,
  removeDirectory = rm,
  removeFile = rm,
  checkDirectory = directoryIsFree,
  ignoreEnv = ensureEnvIsIgnored,
  storeCredential = storeRegistryCredential,
}) {
  if (!(await checkDirectory(projectPath))) {
    throw new Error(directoryInUse(projectPath));
  }

  // The scaffolder is installed outside the project so the customer's directory
  // never contains our helper node_modules.
  const toolDirectory = await makeTempDirectory(join(tmpdir(), 'create-tetra-'));
  const toolConfig = join(toolDirectory, '.npmrc');

  try {
    await writeSecretFile(
      toolConfig,
      `${files.projectNpmrc.trimEnd()}\n${files.userNpmrcEntry}\n`,
      { write: writeProjectFile, remove: removeFile },
    );

    const environment = { ...process.env, NPM_CONFIG_USERCONFIG: toolConfig };

    write(`${SCAFFOLDER} ophalen uit jouw registry...\n`);
    await exec(
      'npm',
      ['install', '--no-save', '--no-package-lock', '--ignore-scripts', '--prefix', toolDirectory, SCAFFOLDER],
      { cwd: toolDirectory, env: environment },
    );

    write('Project genereren...\n');
    await makeDirectory(projectPath, { recursive: true, mode: 0o700 });
    // mkdir leaves the mode of an existing directory alone, and an existing
    // empty directory is a valid target.
    await setMode(projectPath, 0o700);
    await exec(join(toolDirectory, 'node_modules', '.bin', SCAFFOLDER_BIN), [projectName, '--dir', projectPath], {
      cwd: toolDirectory,
      env: environment,
    });

    // The scaffolder writes a maintainer-facing .npmrc pointing at the internal
    // registry. Ours has to land after it, deliberately.
    write('Jouw registry-toegang en licentie wegschrijven...\n');
    await writeSecretFile(join(projectPath, '.npmrc'), files.projectNpmrc, {
      write: writeProjectFile,
      remove: removeFile,
    });
    await writeSecretFile(join(projectPath, '.env'), files.env, {
      write: writeProjectFile,
      remove: removeFile,
    });
    await ignoreEnv(projectPath);

    const credentialPath = await storeCredential(files);
    write(`Registry-token opgeslagen in ${credentialPath}.\n`);

    // Prove the project can install before telling the customer that it can.
    // Buffered output on the longest step is a trap: the default 1 MB cap makes
    // a chatty install fail after it actually succeeded.
    write('Dependencies installeren, dit duurt even...\n');
    await exec('npm', ['install'], {
      cwd: projectPath,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
  } finally {
    await removeDirectory(toolDirectory, { recursive: true, force: true });
  }

  return { projectPath, projectName };
}

export function formatNextSteps({ projectPath, projectName }, { cwd = process.cwd() } = {}) {
  // basename is only the right thing to cd into when the project is a direct
  // child of where the customer stands, which `npx create-tetra` without an
  // argument is not.
  const step = relative(cwd, projectPath);
  return [
    '',
    `Klaar. ${projectName} staat in ${projectPath}.`,
    '',
    'Volgende stappen:',
    ...(step === '' ? [] : [`  cd ${step}`]),
    '  npm run dev',
    '',
    'Je registry-token staat in je gebruikers-npmrc, zodat npm install blijft werken.',
    'Je licentiesleutel staat in .env; dat bestand hoort niet in git en is al genegeerd.',
    '',
  ].join('\n');
}

export { ensureEnvIsIgnored, writeSecretFile, replaceUserFile };

import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve as resolvePathname, sep } from 'node:path';
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

// npm reads the userconfig the environment points at rather than the one in the
// home directory, so a customer's own NPM_CONFIG_USERCONFIG has to be honoured.
//
// Only the uppercase form. npx injects `npm_config_userconfig` itself, already
// resolved and already absolute, and that resolution honours `userconfig=` from
// a project .npmrc — so on POSIX the lowercase variable is npm's own answer to a
// question the working directory got to influence, not the customer's intent.
// Reading it would let any repository someone happens to stand in decide where
// their personal registry token is written.
//
// Windows environment lookups are case-insensitive, so there the two cannot be
// told apart. The containment check below is what covers that: a userconfig
// inside the current working directory is never a real user-level config, and is
// exactly what a hostile repository would point at.
export function resolveUserConfigPath({
  env = process.env,
  fallback = join(homedir(), '.npmrc'),
  cwd = process.cwd(),
} = {}) {
  const configured = (env.NPM_CONFIG_USERCONFIG ?? '').trim();
  if (configured === '') return fallback;

  const expanded = configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured;
  if (!isAbsolute(expanded)) return fallback;

  const inCwd = resolvePathname(expanded).startsWith(`${resolvePathname(cwd)}${sep}`);
  return inCwd ? fallback : expanded;
}

// This is the one file create-tetra touches that it does not own. It may hold
// the customer's npmjs login and every other registry they use, so it is
// replaced atomically: a temp file in the same directory, then a rename. There
// is no moment where the file does not exist, and a failed write leaves the
// original untouched.
async function replaceUserFile(
  path,
  content,
  { write: writeImpl = writeFile, move = rename, remove = rm, makeDirectory = mkdir } = {},
) {
  // A dangling symlink usually means the dotfiles repository has not been cloned
  // yet, so the directory it points into does not exist either. Failing here
  // with a raw ENOENT would strand the customer after the grant is already spent.
  await makeDirectory(dirname(path), { recursive: true });

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
    describeLink = async (candidate) => lstat(candidate).catch(() => null),
    readLinkImpl = readlink,
    resolvePath = resolveUserConfigPath,
  } = {},
) {
  const configured = path ?? resolvePath();

  // A symlinked npmrc usually points into a dotfiles repository. Replacing the
  // link would silently detach the customer from their own config management,
  // so write through to whatever it points at. lstat rather than realpath,
  // because a dangling link — dotfiles not checked out yet — must be followed
  // too instead of being quietly turned into a regular file.
  // readlink resolves one level, so a chain (top -> mid -> real) would leave the
  // middle link replaced by a regular file and the real content out of the
  // effective config. Walk to the end, with a cap so a loop cannot hang us.
  let target = configured;
  for (let hop = 0; hop < 32; hop += 1) {
    const link = await describeLink(target);
    if (!link?.isSymbolicLink()) break;
    const destination = await readLinkImpl(target);
    target = isAbsolute(destination) ? destination : join(dirname(target), destination);
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
  let installed = true;
  let installFailure = null;

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
    try {
      await exec('npm', ['install'], {
        cwd: projectPath,
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15 * 60_000,
      });
    } catch (error) {
      // This is the longest and least reliable step, and it sits past the point
      // of no return: the grant is spent and the directory is no longer empty,
      // so re-running create-tetra is not an option. The project itself is fine
      // and one command away, so say that instead of failing opaquely.
      const reason = error.killed && error.signal === 'SIGTERM'
        ? 'het duurde langer dan 15 minuten'
        : (error.message ?? 'onbekende fout').split('\n')[0];
      installed = false;
      installFailure = reason;
      write([
        '',
        `Het project staat in ${projectPath} en je registry-token is opgeslagen.`,
        `Alleen het installeren van de dependencies is afgebroken (${reason}).`,
        '',
        'Draai om verder te gaan:',
        `  cd ${projectPath} && npm install`,
        '',
      ].join('\n'));
    }
  } finally {
    await removeDirectory(toolDirectory, { recursive: true, force: true });
  }

  return { projectPath, projectName, installed, installFailure };
}

export function formatNextSteps({ projectPath, projectName, installed = true }, { cwd = process.cwd() } = {}) {
  // The recovery instructions were already printed; do not follow them with a
  // cheerful "klaar" that contradicts them.
  if (!installed) return '';
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

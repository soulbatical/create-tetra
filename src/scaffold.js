import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve as resolvePathname, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const SCAFFOLDER = '@soulbatical/create-app';
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
// Windows environment lookups are case-insensitive, so there npm's injection
// arrives under this name too and nothing distinguishes it from the customer's
// own setting. Containment does not rescue that. A hostile project .npmrc never
// had to point inside the repository — `userconfig=../dotfiles/.npmrc` resolves
// to an absolute path beside it — and a cloned repository normally sits under
// the home directory, so the target clears isAbsolute, the in-cwd rule and the
// home boundary all at once. Worse than a path: storeRegistryCredential keeps
// whatever the file already held, so the repository would get to choose which
// existing file the token is appended to, invisibly.
//
// So on win32 the environment is not read at all and the home-directory npmrc is
// used instead. That costs the Windows customer who genuinely set the variable,
// which is why it is reported rather than done quietly. On POSIX the uppercase
// name can only be his own doing, so it is still honoured, and the containment
// rules below stay as the second line under it.
//
// Refusing a setting silently is its own trap: npm then reads a different file
// than the customer configured, and the install fails later with a bare 401. So
// report which setting was dropped and why, and let the caller say it out loud.
export function resolveUserConfig({
  env = process.env,
  home = homedir(),
  fallback = join(home, '.npmrc'),
  cwd = process.cwd(),
  platform = process.platform,
} = {}) {
  const configured = (env.NPM_CONFIG_USERCONFIG ?? '').trim();
  if (configured === '') return { path: fallback, ignored: null };

  // Nothing below can tell npm's echo from the customer's intent on win32, so
  // there is nothing here worth inspecting on that platform.
  if (platform === 'win32') return { path: fallback, ignored: { value: configured, reason: 'win32' } };

  // npm's parseField also expands `~\` on win32, but a win32 value never reaches
  // this line, so `~/` is the only form that can arrive here.
  const expanded = /^~\//.test(configured) ? join(home, configured.slice(2)) : configured;

  // npm resolves a relative path against its cwd, which is the directory we
  // deliberately do not let decide this. Fall back rather than follow.
  if (!isAbsolute(expanded)) return { path: fallback, ignored: { value: configured, reason: 'relative' } };

  const target = resolvePathname(expanded);
  if (target.startsWith(`${resolvePathname(cwd)}${sep}`)) {
    return { path: fallback, ignored: { value: configured, reason: 'in-cwd' } };
  }

  // The home directory itself counts: `NPM_CONFIG_USERCONFIG=~` is degenerate,
  // but the boundary should be the directory and everything under it, not
  // everything under it alone.
  const root = resolvePathname(home);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return { path: fallback, ignored: { value: configured, reason: 'outside-home' } };
  }

  return { path: expanded, ignored: null };
}

export function resolveUserConfigPath(options = {}) {
  return resolveUserConfig(options).path;
}

const USER_CONFIG_REASONS = {
  relative: 'dat pad is relatief en zou van je huidige map afhangen',
  'in-cwd': 'dat pad ligt in je huidige map en is dus geen persoonlijke configuratie',
  'outside-home': 'dat pad ligt buiten je home-map en is dus geen persoonlijke configuratie',
  win32: 'op Windows is die waarde niet te onderscheiden van de waarde die npx zelf zet',
};

const userConfigNotice = ({ value, reason }, path) =>
  `Let op: NPM_CONFIG_USERCONFIG staat op ${value}; ${USER_CONFIG_REASONS[reason]}.\nJe registry-token gaat naar ${path}.\n`;

// npx hands us npm's resolution of whatever directory the customer was standing
// in as npm_config_* variables, and npm reads those back with a higher priority
// than the config file we point it at. Passing them through would let that
// directory choose the registry and the credential file for both installs, so
// the whole family goes and only what we set explicitly remains.
function npmEnvironment(base, overrides) {
  const environment = { ...base };
  for (const key of Object.keys(environment)) {
    if (/^npm_config_/i.test(key)) delete environment[key];
  }
  return { ...environment, ...overrides };
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

const MAX_SYMLINK_HOPS = 10;

const symlinkLoop = (path) => [
  `${path} is een symlink die na ${MAX_SYMLINK_HOPS} stappen nog steeds naar een symlink wijst.`,
  'Dat is vrijwel zeker een lus, en er is dus geen bestand om je registry-token in te zetten.',
  'Repareer de symlink, of wijs NPM_CONFIG_USERCONFIG naar een echt bestand.',
].join('\n');

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
  //
  // readlink resolves one level, so a chain (top -> mid -> real) would leave the
  // middle link replaced by a regular file and the real content out of the
  // effective config. Walk to the end instead. A loop has no end, so the walk
  // needs a cap — and reaching that cap is not a place to write the token
  // anyway: it would land on whichever link the walk stopped on and flatten it.
  // POSIX allows around 40 hops; a real dotfiles setup never needs ten.
  let target = configured;
  for (let hop = 0; ; hop += 1) {
    const link = await describeLink(target);
    if (!link?.isSymbolicLink()) break;
    if (hop >= MAX_SYMLINK_HOPS) throw new Error(symlinkLoop(configured));
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

const lastLine = (text) => {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.at(-1) ?? null;
};

// execFile puts the whole command line and all of the child's stderr into
// error.message, so passing that on hands the customer a wall of text whose
// first line is the useless `Command failed: npm install`. The line he needs —
// ENOSPC, 401, ERESOLVE, ENOTFOUND — is the last one npm wrote.
const commandReason = (error) => lastLine(error.stderr) ?? (error.message ?? 'onbekende fout').split('\n')[0];

// Everything installProject does runs after the grant has been spent, so any
// failure in here costs the customer his approval. Saying so is the difference
// between "try again" and "why did nothing happen".
const spentGrant = (what, reason, retry, leftBehind = null) => [
  `${what}: ${reason}`,
  '',
  ...(leftBehind ? [`Wat er staat in ${leftBehind} is onvolledig; verwijder die map.`] : ['Er is nog niets geïnstalleerd.']),
  'Je goedkeuring is wel verbruikt, dus je keurt opnieuw goed in de browser.',
  '',
  `Los het probleem hierboven op en draai dan: ${retry}`,
].join('\n');

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
  environment: inherited = process.env,
  resolveUserConfig: resolveConfig = resolveUserConfig,
  cwd = process.cwd(),
}) {
  if (!(await checkDirectory(projectPath))) {
    throw new Error(directoryInUse(projectPath));
  }

  // The scaffolder is installed outside the project so the customer's directory
  // never contains our helper node_modules.
  const toolDirectory = await makeTempDirectory(join(tmpdir(), 'create-tetra-'));
  const toolConfig = join(toolDirectory, '.npmrc');
  let installed = true;

  // Resolved once, up front: it decides both where the credential is written and
  // which file the project install is pointed at. Those two must be the same
  // file, or we store a token npm never reads.
  const userConfig = resolveConfig();
  if (userConfig.ignored) write(userConfigNotice(userConfig.ignored, userConfig.path));

  // The basename is only what the customer typed when the project is a direct
  // child of where he stands, so `apps/my-app` would come back as `my-app`.
  const retry = ['npx create-tetra', relative(cwd, projectPath)].join(' ').trim();

  try {
    await writeSecretFile(
      toolConfig,
      `${files.projectNpmrc.trimEnd()}\n${files.userNpmrcEntry}\n`,
      { write: writeProjectFile, remove: removeFile },
    );

    const environment = npmEnvironment(inherited, { NPM_CONFIG_USERCONFIG: toolConfig });

    write(`${SCAFFOLDER} ophalen uit jouw registry...\n`);
    try {
      await exec(
        'npm',
        ['install', '--no-save', '--no-package-lock', '--ignore-scripts', '--prefix', toolDirectory, SCAFFOLDER],
        { cwd: toolDirectory, env: environment },
      );
    } catch (error) {
      // A broken npm cache, a full disk or a proxy in the way is the ordinary
      // way this fails, and none of it is the customer's fault or his to guess.
      throw new Error(spentGrant(`${SCAFFOLDER} ophalen uit jouw registry is mislukt`, commandReason(error), retry));
    }

    write('Project genereren...\n');
    await makeDirectory(projectPath, { recursive: true, mode: 0o700 });
    // mkdir leaves the mode of an existing directory alone, and an existing
    // empty directory is a valid target.
    await setMode(projectPath, 0o700);
    try {
      await exec(join(toolDirectory, 'node_modules', '.bin', SCAFFOLDER_BIN), [projectName, '--dir', projectPath], {
        cwd: toolDirectory,
        env: environment,
      });
    } catch (error) {
      // Same position, same raw failure — only by now the project directory
      // exists and holds a half-written project, so it has to be named.
      throw new Error(spentGrant('Het genereren van je project is mislukt', commandReason(error), retry, projectPath));
    }

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

    // Same position as the dependency install below: the grant is spent and the
    // project is generated, so a bare throw here strands the customer with a
    // stack trace and no idea what state anything is in. The likely cause — a
    // dotfiles directory that is not cloned yet — is created by replaceUserFile,
    // but a symlink loop or an unwritable home is not fixable from here.
    //
    // Without a stored token the dependency install can only return a 401, so
    // stop rather than stack a second, more confusing failure on top of this
    // one. Recovering means a fresh approval, and a fresh approval needs an
    // empty directory, so say both instead of suggesting a rerun that this very
    // project directory would now refuse.
    let credentialPath;
    try {
      credentialPath = await storeCredential(files, { path: userConfig.path });
    } catch (error) {
      installed = false;
      write([
        '',
        'Je registry-token kon niet worden opgeslagen:',
        `  ${error.message}`,
        '',
        `Het project staat in ${projectPath}, maar zonder dat token kan npm de`,
        '@soulbatical-packages niet ophalen.',
        '',
        'Los het pad hierboven op, verwijder die projectmap of kies een andere naam,',
        `en draai dan opnieuw: ${retry}`,
        '',
        'Je keurt dan opnieuw goed in de browser; deze goedkeuring is verbruikt.',
        '',
      ].join('\n'));
      return { projectPath, projectName, installed };
    }
    write(`Registry-token opgeslagen in ${credentialPath}.\n`);

    // Prove the project can install before telling the customer that it can.
    // Buffered output on the longest step is a trap: the default 1 MB cap makes
    // a chatty install fail after it actually succeeded.
    write('Dependencies installeren, dit duurt even...\n');
    try {
      await exec('npm', ['install'], {
        cwd: projectPath,
        env: npmEnvironment(inherited, { NPM_CONFIG_USERCONFIG: userConfig.path }),
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15 * 60_000,
      });
    } catch (error) {
      // This is the longest and least reliable step, and it sits past the point
      // of no return: the grant is spent and the directory is no longer empty,
      // so re-running create-tetra is not an option. The project itself is fine
      // and one command away, so say that instead of failing opaquely.
      // libuv terminates a timed-out child on Windows without a term signal, so
      // `killed` alone is the discriminator that holds on both platforms. And
      // `error.message` is the generic `Command failed: npm install`; the reason
      // the customer needs — 401, ERESOLVE, ENOTFOUND — is on stderr.
      const reason = error.killed ? 'het duurde langer dan 15 minuten' : commandReason(error);
      installed = false;
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

  return { projectPath, projectName, installed };
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

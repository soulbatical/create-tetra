import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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

// npm looks for credentials in the user-level npmrc, so that is where they go.
// Only the one line for this registry is touched; everything else in the file is
// preserved.
export async function storeRegistryCredential(
  { authKey, token },
  { path = join(homedir(), '.npmrc'), read = readFile, write: writeImpl = writeFile, remove = rm } = {},
) {
  let current = '';
  try {
    current = await read(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const kept = current
    .split('\n')
    .filter((line) => !line.trim().startsWith(`${authKey}:_authToken=`));
  while (kept.length > 0 && kept.at(-1).trim() === '') kept.pop();
  kept.push(`${authKey}:_authToken=${token}`, '');

  await writeSecretFile(path, kept.join('\n'), { write: writeImpl, remove });
  return path;
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
    write('Dependencies installeren...\n');
    await exec('npm', ['install'], { cwd: projectPath, env: process.env });
  } finally {
    await removeDirectory(toolDirectory, { recursive: true, force: true });
  }

  return { projectPath, projectName };
}

export function formatNextSteps({ projectPath, projectName }) {
  return [
    '',
    `Klaar. ${projectName} staat in ${projectPath}.`,
    '',
    'Volgende stappen:',
    `  cd ${projectName}`,
    '  npm run dev',
    '',
    'Je registry-token staat in je gebruikers-npmrc, zodat npm install blijft werken.',
    'Je licentiesleutel staat in .env; dat bestand hoort niet in git en is al genegeerd.',
    '',
  ].join('\n');
}

export { ensureEnvIsIgnored, writeSecretFile };

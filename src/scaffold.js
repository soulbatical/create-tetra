import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SCAFFOLDER = '@soulbatical/create-app';
const SCAFFOLDER_BIN = 'create-soulbatical-app';

export async function directoryIsFree(path) {
  try {
    return (await readdir(path)).length === 0;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

// The scaffolder ships templates aimed at the maintainers: the .npmrc it writes
// points at the internal GitHub Packages registry and its instructions tell you
// to pull an org-wide token out of Doppler. A customer has neither. So we let it
// generate the project and then write the customer's own registry access over
// the top — last write wins, deliberately.
async function applyCustomerAccess(projectPath, files, writeProjectFile, removeFile) {
  // The scaffolder already wrote its own .npmrc, so this one must replace it —
  // but the mode of an existing file is not changed by writeFile, and these
  // carry a credential. Remove first, then create with the mode we want.
  for (const [name, content] of [['.npmrc', files.npmrc], ['.env', files.env]]) {
    const path = join(projectPath, name);
    await removeFile(path, { force: true });
    await writeProjectFile(path, content, { mode: 0o600, flag: 'wx' });
  }
}

async function ensureEnvIsIgnored(projectPath, { read = readFile, write: writeFileImpl = writeFile } = {}) {
  const path = join(projectPath, '.gitignore');
  let current = '';
  try {
    current = await read(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current.split('\n').some((line) => line.trim() === '.env')) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeFileImpl(path, `${current}${separator}.env\n`);
}

export async function installProject({
  projectPath,
  projectName,
  files,
  write,
  exec = run,
  makeDirectory = mkdir,
  makeTempDirectory = mkdtemp,
  writeProjectFile = writeFile,
  removeDirectory = rm,
  removeFile = rm,
  checkDirectory = directoryIsFree,
  ignoreEnv = ensureEnvIsIgnored,
}) {
  if (!(await checkDirectory(projectPath))) {
    throw new Error(`De map ${projectPath} bestaat al en is niet leeg.`);
  }

  // The scaffolder is installed outside the project so the customer's directory
  // never contains our helper node_modules.
  const toolDirectory = await makeTempDirectory(join(tmpdir(), 'create-tetra-'));
  const toolConfig = join(toolDirectory, '.npmrc');

  try {
    await writeProjectFile(toolConfig, files.npmrc, { mode: 0o600, flag: 'wx' });

    const environment = {
      ...process.env,
      NPM_TOKEN: files.token,
      NPM_CONFIG_USERCONFIG: toolConfig,
    };

    write(`${SCAFFOLDER} ophalen uit jouw registry...\n`);
    await exec('npm', ['install', '--no-save', '--no-package-lock', '--prefix', toolDirectory, SCAFFOLDER], {
      cwd: toolDirectory,
      env: environment,
    });

    write('Project genereren...\n');
    await makeDirectory(projectPath, { recursive: true, mode: 0o700 });
    await exec(join(toolDirectory, 'node_modules', '.bin', SCAFFOLDER_BIN), [projectName, '--dir', projectPath], {
      cwd: toolDirectory,
      env: environment,
    });

    write('Jouw registry-toegang en licentie wegschrijven...\n');
    await applyCustomerAccess(projectPath, files, writeProjectFile, removeFile);
    await ignoreEnv(projectPath);
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
    '  npm install',
    '  npm run dev',
    '',
    'Je registry-toegang staat in .npmrc en je token en licentiesleutel in .env.',
    'Dat .env-bestand hoort niet in git; create-tetra heeft het al genegeerd.',
    '',
  ].join('\n');
}

export { ensureEnvIsIgnored };

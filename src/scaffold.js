import { execFile } from 'node:child_process';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SCAFFOLDER = '@soulbatical/create-app';

async function isUsableDirectory(path) {
  try {
    const entries = await readdir(path);
    return entries.length === 0;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

// Everything the customer used to do by hand — create the directory, point npm at
// their own registry, drop in the licence, install the scaffolder — happens here.
// No org-wide token, no Doppler, no manual .npmrc.
export async function installProject({
  projectPath,
  projectName,
  files,
  write,
  exec = run,
  makeDirectory = mkdir,
  writeProjectFile = writeFile,
  checkDirectory = isUsableDirectory,
}) {
  if (!(await checkDirectory(projectPath))) {
    throw new Error(`De map ${projectPath} bestaat al en is niet leeg.`);
  }

  await makeDirectory(projectPath, { recursive: true });
  await writeProjectFile(join(projectPath, '.npmrc'), files.npmrc, { mode: 0o600 });
  await writeProjectFile(join(projectPath, '.env'), files.env, { mode: 0o600 });
  write('Registry en licentie ingesteld voor dit project.\n');

  write(`${SCAFFOLDER} ophalen...\n`);
  // The scaffolder runs inside projectPath so it picks up the .npmrc we just
  // wrote; NPM_TOKEN comes from the environment, never from the config file.
  const environment = {
    ...process.env,
    NPM_TOKEN: files.token,
    NPM_CONFIG_USERCONFIG: join(projectPath, '.npmrc'),
  };

  await exec('npm', ['install', '--no-save', '--no-package-lock', SCAFFOLDER], {
    cwd: projectPath,
    env: environment,
  });

  write('Project genereren...\n');
  await exec('npx', ['--no-install', SCAFFOLDER, projectName, '--dir', '.'], {
    cwd: projectPath,
    env: environment,
  });

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
    'Je registry-token en licentiesleutel staan in .env. Commit dat bestand niet.',
    '',
  ].join('\n');
}

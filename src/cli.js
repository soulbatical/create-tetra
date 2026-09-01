import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { renderProjectFiles } from './claim.js';
import { createControlPlaneClient } from './control-plane-client.js';
import { openBrowser } from './open-browser.js';
import { directoryInUse, directoryIsFree, formatNextSteps, installProject } from './scaffold.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// A prerelease version is a reserved name claim, not a usable bootstrap. npm can
// attach `latest` to the first version of a brand-new package regardless of the
// publish dist-tag, so the artifact itself has to refuse to run.
export function isReservedRelease(version) {
  const [core] = version.split('+', 1); // build metadata may contain '-' and is not a prerelease
  return core.includes('-');
}

const RESERVED_NOTICE = `create-tetra is nog niet beschikbaar.

Deze versie is een gereserveerde naamclaim en installeert bewust niets.
Volg https://github.com/soulbatical/create-tetra voor de eerste echte release.
`;

const HELP = `create-tetra ${VERSION}

Zet een nieuw Tetra-project op.

Gebruik:
  npx create-tetra [project-map]

De CLI opent een beveiligde goedkeuring in je browser. Daar zie en bevestig je
organisatie, licentie en project. Daarna richt create-tetra je project in met je
eigen registry-toegang en licentie; je hoeft zelf geen token te regelen.
`;

function parseArgs(argv, cwd) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.includes('--version') || argv.includes('-v')) return { version: true };
  const options = argv.filter((arg) => arg.startsWith('-'));
  if (options.length > 0) throw new Error(`Onbekende optie: ${options[0]}`);
  if (argv.length > 1) throw new Error('Geef maximaal één project-map op.');
  return { projectPath: resolve(cwd, argv[0] ?? '.'), targets: ['local'] };
}

export async function runCreateTetra({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  client = createControlPlaneClient(),
  browser = openBrowser,
  write = (text) => process.stdout.write(text),
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  now = () => Date.now(),
  version = VERSION,
  install = installProject,
  checkDirectory = directoryIsFree,
} = {}) {
  const parsed = parseArgs(argv, cwd);
  if (parsed.help) { write(HELP); return { kind: 'help' }; }
  if (parsed.version) { write(`${version}\n`); return { kind: 'version' }; }
  if (isReservedRelease(version)) { write(RESERVED_NOTICE); return { kind: 'unavailable' }; }

  const projectName = basename(parsed.projectPath) || 'tetra-app';
  write(`Tetra\nProject: ${projectName}\n\n`);

  // Before anything else: a target we cannot use must not cost the customer an
  // approval. A grant is single-use, so failing after it is spent means they
  // have to start over for a mistake we could see up front.
  if (!(await checkDirectory(parsed.projectPath))) {
    throw new Error(directoryInUse(parsed.projectPath));
  }

  write('Goedkeuring aanvragen...\n');
  const authorization = await client.requestAuthorization({
    action: 'install',
    project: { name: projectName },
    targets: parsed.targets,
  });
  write(`Open: ${authorization.verificationUri}\n`);
  write(`Bevestigingscode: ${authorization.userCode}\n`);
  browser(authorization.verificationUri);
  write('Wachten op jouw goedkeuring in de browser...\n');

  let status;
  while (now() < authorization.expiresAt) {
    await sleep(authorization.intervalSeconds * 1_000);
    status = await client.pollAuthorization(authorization.deviceCode);
    if (status.status === 'pending') continue;
    if (status.status === 'denied') throw new Error('De installatie is in de browser geweigerd.');
    if (status.status === 'expired') throw new Error('De goedkeuring is verlopen.');
    break;
  }
  if (!status || status.status !== 'approved') throw new Error('De goedkeuring is verlopen.');

  write('Goedgekeurd.\n');
  const claim = await client.claim(status.installGrant);
  const files = renderProjectFiles(claim);

  const result = await install({
    projectPath: parsed.projectPath,
    projectName,
    files,
    write,
    checkDirectory,
  });

  write(formatNextSteps(result));
  return { kind: 'installed', project: result };
}

export async function main() {
  const run = await runCreateTetra();
  if (run.kind === 'unavailable') process.exitCode = 1;
}

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createControlPlaneClient } from './control-plane-client.js';
import { formatInstallResult, summarizeInstallResult } from './contracts.js';
import { openBrowser } from './open-browser.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const HELP = `create-tetra ${VERSION}

Publieke, interactieve bootstrap voor een Tetra-app.

Gebruik:
  npx create-tetra@latest [project-map]

De CLI opent een beveiligde browsergoedkeuring. Daar ziet en bevestigt de
gebruiker organisatie, licentie en installatieactie voordat Tetra iets wijzigt.
`;

function parseArgs(argv, cwd) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.includes('--version') || argv.includes('-v')) return { version: true };
  const options = argv.filter((arg) => arg.startsWith('-'));
  if (options.length > 0) throw new Error(`Onbekende optie: ${options[0]}`);
  if (argv.length > 1) throw new Error('Geef maximaal één project-map op.');
  return { projectPath: resolve(cwd, argv[0] ?? '.'), targets: ['local'], verifyCleanCache: true };
}

export async function runCreateTetra({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  client = createControlPlaneClient(),
  browser = openBrowser,
  write = (text) => process.stdout.write(text),
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  now = () => Date.now(),
} = {}) {
  const parsed = parseArgs(argv, cwd);
  if (parsed.help) { write(HELP); return { kind: 'help' }; }
  if (parsed.version) { write(`${VERSION}\n`); return { kind: 'version' }; }

  const projectName = basename(parsed.projectPath) || 'tetra-app';
  write(`Tetra bootstrap\nProject: ${projectName}\nActie: installeren\n\n`);
  write('Beveiligde browsergoedkeuring aanvragen...\n');
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
    if (status.status === 'expired') throw new Error('De browsergoedkeuring is verlopen.');
    break;
  }
  if (!status || status.status !== 'approved') throw new Error('De browsergoedkeuring is verlopen.');

  write('Goedgekeurd. Tetra configureert de installatie...\n');
  const result = await client.install({
    installGrant: status.installGrant,
    projectName,
    targets: parsed.targets,
    verifyCleanCache: parsed.verifyCleanCache,
  });
  const outcome = summarizeInstallResult(result);
  write(formatInstallResult(result, outcome));
  return { kind: 'installed', outcome, result };
}

export async function main() {
  const run = await runCreateTetra();
  if (run.kind === 'installed' && run.outcome === 'failed') process.exitCode = 1;
}

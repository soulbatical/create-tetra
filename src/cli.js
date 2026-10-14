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

// The scaffolder enforces this, and it does so after we have already spent the
// customer's single-use grant. Checking it here costs nothing and turns the most
// likely first command — `npx create-tetra MyApp` — into a useful message
// instead of a dead end.
const PROJECT_NAME = /^[a-z][a-z0-9-]*$/;

// A code outlives the TTL the control plane put on it (10 minutes, but its
// own contract allows up to 15 — see contracts.js), not the email round trip
// a human actually needs: open the link, type an address, open the inbox,
// click the magic link. Measured in training on 2026-10-13, that round trip
// routinely ran past the TTL, and the CLI's only answer was to throw the
// whole run away — the loop Albert kept hitting. Renewing is cheap for the
// control plane (it is just a fresh `create()`) and invisible to someone
// still mid-roundtrip when their old code dies, so this asks for a new one
// automatically instead of making the customer re-run the command. Still
// bounded: an authorization nobody is ever going to approve must not poll
// forever.
//
// Review on soulbatical/create-tetra#6 measured that a fixed time budget and
// a fixed renewal count drift apart depending on which TTL the control plane
// happens to issue: a budget sized for a 10-minute TTL makes the count bound
// unreachable at 10, and dead again if the server ever issues the full
// 15 minutes the contract allows. The deadline is derived from the TTL the
// first authorization actually came back with instead of a separate
// constant, so the two bounds cannot diverge by construction — see
// `deadlineFor` below.
const DEFAULT_MAX_RENEWALS = 4;

/** `maxRenewals` full-TTL cycles from the moment the first code was issued. */
function deadlineFor(authorization, maxRenewals, now) {
  const ttlMs = authorization.expiresAt - now();
  return authorization.expiresAt + maxRenewals * ttlMs;
}

export function projectNameProblem(name) {
  if (PROJECT_NAME.test(name)) return null;
  return `De projectnaam "${name}" kan niet: gebruik kleine letters, cijfers en streepjes, beginnend met een letter (bijvoorbeeld my-app).`;
}

function parseArgs(argv, cwd) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.includes('--version') || argv.includes('-v')) return { version: true };
  const options = argv.filter((arg) => arg.startsWith('-'));
  if (options.length > 0) throw new Error(`Onbekende optie: ${options[0]}`);
  if (argv.length > 1) throw new Error('Geef maximaal één project-map op.');
  return { projectPath: resolve(cwd, argv[0] ?? '.'), targets: ['local'] };
}

// One explicit line for whatever is reading this output, human or not: the
// wait is intentional, bounded, and self-healing, so there is nothing useful
// to do by killing and restarting the process. An AI agent that does not read
// this and retries the whole command instead burns a fresh approval attempt
// for nothing — exactly the loop this file exists to stop.
function waitingInstructions(deadline) {
  return [
    'Instructie voor AI-assistenten: open de link hierboven zelf (of laat een mens dat',
    'doen) en bevestig daar de installatie. Dit proces wacht automatisch en vraagt zelf',
    `een nieuwe code aan als de huidige verloopt. Ik wacht tot ${new Date(deadline).toISOString()};`,
    'herstart dit commando niet in de tussentijd.',
    '',
  ].join('\n');
}

// Polls one authorization until it resolves, and — unlike a single poll loop
// — keeps going across an expiry by asking the control plane for a fresh one.
// `request` is the exact payload the first authorization was created from, so
// a renewal asks for the same project and targets, not whatever the customer
// might be standing in front of by then.
async function waitForApproval({
  client,
  request,
  authorization,
  browser,
  sleep,
  now,
  write,
  maxRenewals,
  deadline,
}) {
  let current = authorization;
  for (let renewal = 0; ; renewal += 1) {
    let status;
    while (now() < current.expiresAt) {
      await sleep(current.intervalSeconds * 1_000);
      let polled;
      try {
        polled = await client.pollAuthorization(current.deviceCode);
      } catch {
        // The client already retried this (control-plane-client.js); giving
        // up here throws away a run that might have up to tens of minutes of
        // budget left over a blip that outlasted a ~1s retry window. A poll
        // is always safe to repeat — the authorization itself is untouched —
        // so treat a failed one like 'pending' and try again next interval.
        continue;
      }
      if (polled.status === 'pending') continue;
      status = polled;
      break;
    }

    if (status?.status === 'denied') throw new Error('De installatie is in de browser geweigerd.');
    if (status?.status === 'approved') return { authorization: current, status };

    // Anything else — expired, or the clock ran out without an answer — is a
    // code nobody approved in time. Try again if the budget allows it.
    if (renewal >= maxRenewals || now() >= deadline) throw new Error('De goedkeuring is verlopen.');

    current = await client.requestAuthorization(request);
    write(
      [
        `Deze code is verlopen. Nieuwe goedkeuring aanvragen (poging ${renewal + 2}/${maxRenewals + 1})...`,
        `Open: ${current.verificationUri}`,
        `Bevestigingscode: ${current.userCode}`,
        '',
      ].join('\n'),
    );
    browser(current.verificationUri, { write });
  }
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
  maxRenewals = DEFAULT_MAX_RENEWALS,
} = {}) {
  const parsed = parseArgs(argv, cwd);
  if (parsed.help) { write(HELP); return { kind: 'help' }; }
  if (parsed.version) { write(`${version}\n`); return { kind: 'version' }; }
  if (isReservedRelease(version)) { write(RESERVED_NOTICE); return { kind: 'unavailable' }; }

  const projectName = basename(parsed.projectPath) || 'tetra-app';
  write(`Tetra\nProject: ${projectName}\n\n`);

  const nameProblem = projectNameProblem(projectName);
  if (nameProblem) throw new Error(nameProblem);

  // Before anything else: a target we cannot use must not cost the customer an
  // approval. A grant is single-use, so failing after it is spent means they
  // have to start over for a mistake we could see up front.
  if (!(await checkDirectory(parsed.projectPath))) {
    throw new Error(directoryInUse(parsed.projectPath));
  }

  const authorizationRequest = { action: 'install', project: { name: projectName }, targets: parsed.targets };

  write('Goedkeuring aanvragen...\n');
  const authorization = await client.requestAuthorization(authorizationRequest);
  const deadline = deadlineFor(authorization, maxRenewals, now);
  write(`Open: ${authorization.verificationUri}\n`);
  write(`Bevestigingscode: ${authorization.userCode}\n`);
  browser(authorization.verificationUri, { write });
  write(waitingInstructions(deadline));
  write('Wachten op jouw goedkeuring in de browser...\n');

  const { status } = await waitForApproval({
    client,
    request: authorizationRequest,
    authorization,
    browser,
    sleep,
    now,
    write,
    maxRenewals,
    deadline,
  });

  write('Goedgekeurd.\n');
  let claim;
  try {
    claim = await client.claim(status.installGrant);
  } catch (error) {
    // claim() is deliberately never retried (it spends a single-use grant),
    // so any failure here — including the network blip waitForApproval just
    // spent tens of minutes surviving on the poll side — ends the run. Said
    // plainly: this is not "the install failed", it is "the approval you
    // just gave is spent", which needs a different next step, and one an AI
    // assistant must not confuse with "restart and wait again".
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Je goedkeuring is binnengekomen, maar het ophalen van je toegang is mislukt: ${reason}`,
        'Die goedkeuring is daarmee verbruikt. Draai het commando opnieuw om een nieuwe aan te vragen.',
      ].join('\n'),
    );
  }
  const files = renderProjectFiles(claim);

  const result = await install({
    projectPath: parsed.projectPath,
    projectName,
    files,
    write,
    checkDirectory,
    cwd,
  });

  write(formatNextSteps(result, { cwd }));
  return { kind: 'installed', project: result };
}

export async function main() {
  const run = await runCreateTetra();
  if (run.kind === 'unavailable') process.exitCode = 1;
  if (run.kind === 'installed' && run.project.installed === false) process.exitCode = 1;
}

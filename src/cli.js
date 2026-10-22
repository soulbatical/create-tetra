import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { renderProjectFiles } from './claim.js';
import { createControlPlaneClient } from './control-plane-client.js';
import {
  exportRegistryCredentials,
  importRegistryCredentials,
  registryDoctor,
} from './credentials.js';
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
  npx create-tetra [project-map] [--name <naam>]
  npx create-tetra --doctor [project-map]
  npx create-tetra --export-credentials <bestand> [project-map]
  npx create-tetra --import-credentials <bestand>

Opties:
  --name <naam>                Projectnaam (kleine letters, cijfers en streepjes).
                               Zonder deze optie leidt create-tetra hem af uit de
                               mapnaam en toont welke naam hij koos.
  --doctor                     Controleer of deze machine je registry-token heeft.
  --export-credentials <pad>   Schrijf je registry-token naar een bestand voor een
                               tweede machine.
  --import-credentials <pad>   Zet zo'n bestand op deze machine.
  --help, -h                   Deze uitleg.
  --version, -v                De versie.

Goedkeuren: de code en de link blijven geldig zolang de goedkeuring loopt (tot
9 uur) en veranderen niet zolang ze geldig zijn. De CLI wacht maximaal 10 uur en
vraagt pas een nieuwe code aan als de server zegt dat de huidige verlopen is. Je
hoeft het commando dus niet opnieuw te starten als je even niet meteen kijkt.

De CLI opent een beveiligde goedkeuring in je browser. Daar zie en bevestig je
organisatie, licentie en project. Daarna richt create-tetra je project in met je
eigen registry-toegang en licentie; je hoeft zelf geen token te regelen.
`;

// The scaffolder enforces this, and it does so after we have already spent the
// customer's single-use grant. Checking it here costs nothing and turns the most
// likely first command — `npx create-tetra MyApp` — into a useful message
// instead of a dead end.
const PROJECT_NAME = /^[a-z][a-z0-9-]*$/;

// A code outlives the old 10-minute TTL: the control plane now issues one that
// stays valid for a working day. The CLI's job is therefore to leave that code
// alone. A new one is only requested when this one is actually over — the
// server says `expired`, or its own `expiresAt` has passed — because rotating
// while the code is still good changes the link under a customer who is in the
// middle of opening it, and forces a second comparison.
//
// The wait is bounded by the wall clock rather than by a renewal count. Four
// renewals used to be the bound when a TTL was minutes; at hours that would be
// days, and at minutes it would stop long before the advertised window. Ten
// hours is the single number the customer is told, the single number the code
// enforces, and the one the final message repeats.
export const WAIT_BUDGET_MS = 10 * 60 * 60_000;

// Kept as an explicit override for callers and tests. The default no longer
// caps renewals: the time budget does, and that is the promise printed to the
// customer.
export const DEFAULT_MAX_RENEWALS = Number.POSITIVE_INFINITY;

const MINUTE_MS = 60_000;

// The waiting line has to say how much time is left, not just until when. An
// ISO timestamp is precise but requires arithmetic from the reader; a duration
// answers the question he is actually asking.
export function formatDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / MINUTE_MS));
  if (totalMinutes < 1) return 'minder dan een minuut';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourText = hours === 1 ? '1 uur' : `${hours} uur`;
  if (hours === 0) return minutes === 1 ? '1 minuut' : `${minutes} minuten`;
  if (minutes === 0) return hourText;
  return `${hourText} en ${minutes === 1 ? '1 minuut' : `${minutes} minuten`}`;
}

export function projectNameProblem(name) {
  if (PROJECT_NAME.test(name)) return null;
  return `De projectnaam "${name}" kan niet: gebruik kleine letters, cijfers en streepjes, beginnend met een letter (bijvoorbeeld my-app).`;
}

// A directory is not a slug. `npx create-tetra .` in `dansschool.crm` used to
// fail on the dots, which taught the customer to rename his own folder or run
// the command one level up. Deriving a slug is what he meant, as long as the CLI
// says which name it chose so the scaffolder and the approval talk about the
// same project.
export function slugFromDirectory(name) {
  const slug = String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug === '') return null;
  return /^[a-z]/.test(slug) ? slug : `app-${slug}`;
}

function parseArgs(argv, cwd) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  if (argv.includes('--version') || argv.includes('-v')) return { version: true };

  let name;
  let file;
  let command = 'create';
  const positionals = [];

  const chooseCommand = (next) => {
    if (command !== 'create') throw new Error('Gebruik één commando per keer.');
    command = next;
  };
  const valueFor = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`Geef ${flag.includes('credentials') ? 'een bestand' : 'een waarde'} op voor ${flag}.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--name') {
      name = valueFor(index, '--name');
      index += 1;
      continue;
    }
    if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
      if (name === '') throw new Error('Geef een projectnaam op voor --name.');
      continue;
    }
    if (arg === '--doctor') {
      chooseCommand('doctor');
      continue;
    }
    if (arg === '--export-credentials') {
      chooseCommand('export');
      file = valueFor(index, '--export-credentials');
      index += 1;
      continue;
    }
    if (arg.startsWith('--export-credentials=')) {
      chooseCommand('export');
      file = arg.slice('--export-credentials='.length);
      if (file === '') throw new Error('Geef een bestand op voor --export-credentials.');
      continue;
    }
    if (arg === '--import-credentials') {
      chooseCommand('import');
      file = valueFor(index, '--import-credentials');
      index += 1;
      continue;
    }
    if (arg.startsWith('--import-credentials=')) {
      chooseCommand('import');
      file = arg.slice('--import-credentials='.length);
      if (file === '') throw new Error('Geef een bestand op voor --import-credentials.');
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Onbekende optie: ${arg}`);
    positionals.push(arg);
  }

  if (name !== undefined && command !== 'create') {
    throw new Error('--name hoort bij het aanmaken van een project.');
  }
  if (positionals.length > 1) {
    throw new Error('Geef maximaal één project-map op.');
  }
  if (command === 'import' && positionals.length > 0) {
    throw new Error('Geef bij --import-credentials alleen het bestand op.');
  }

  return {
    command,
    name,
    file: file === undefined ? undefined : resolve(cwd, file),
    projectPath: resolve(cwd, positionals[0] ?? '.'),
    targets: ['local'],
  };
}

// One explicit line for whatever is reading this output, human or not: the
// wait is intentional, bounded, and self-healing, so there is nothing useful
// to do by killing and restarting the process. An AI agent that does not read
// this and retries the whole command instead burns a fresh approval attempt
// for nothing — exactly the loop this file exists to stop.
function waitingInstructions(deadline, now) {
  return [
    'Instructie voor AI-assistenten: open de link hierboven zelf (of laat een mens dat',
    'doen) en bevestig daar de installatie. Deze code en link blijven geldig zolang de goedkeuring loopt;',
    'je hoeft ze niet te vernieuwen. Het proces vraagt pas een nieuwe code aan als de server zegt',
    'dat deze verlopen is.',
    `Ik wacht tot ${new Date(deadline).toISOString()} (nog ${formatDuration(deadline - now())});`,
    'herstart dit commando niet in de tussentijd.',
    '',
  ].join('\n');
}

// Polls one authorization until it resolves. A renewal only happens when the
// code is actually over: either the server returned `expired`, or its own
// `expiresAt` has passed. While the authorization is valid it is never replaced,
// so the code and the link the customer is looking at stay the same.
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
  budgetMs,
}) {
  let current = authorization;
  for (let renewal = 0; ; renewal += 1) {
    let status;
    // The deadline is what `waitingInstructions()` printed as "I wait until
    // X" — a promise an AI assistant is told to trust and not restart around.
    // Clamping to whichever comes first keeps the printed deadline honest even
    // when a later renewal carries a much longer TTL.
    const cycleEnd = Math.min(current.expiresAt, deadline);
    while (now() < cycleEnd) {
      await sleep(current.intervalSeconds * 1_000);
      let polled;
      try {
        polled = await client.pollAuthorization(current.deviceCode);
      } catch (error) {
        // The client already retried a transient failure once
        // (control-plane-client.js); giving up here throws away a run that
        // might have hours of budget left over a blip that outlasted that ~1s
        // retry window. But not every failure is a blip: a 404 or a contract
        // violation is a real answer, and swallowing it would poll for the
        // whole budget before ending in a misleading expiry message.
        if (!error.transient) throw error;
        continue;
      }
      if (polled.status === 'pending') continue;
      status = polled;
      break;
    }

    if (status?.status === 'denied') {
      throw new Error(
        [
          'Geannuleerd: je hebt de installatie in de browser geweigerd.',
          'Er is niets geïnstalleerd en je goedkeuring is niet verbruikt.',
        ].join('\n'),
      );
    }
    if (status?.status === 'approved') return { authorization: current, status };

    // Anything else — expired, or the clock ran out without an answer — is a
    // code nobody approved in time. Try again only if there is budget left.
    if (renewal >= maxRenewals || now() >= deadline) {
      throw new Error(
        [
          `Verlopen: de goedkeuring is niet binnen ${formatDuration(budgetMs)} gegeven.`,
          'De laatste code is verlopen en de CLI is gestopt met wachten.',
          'Er is niets geïnstalleerd en je goedkeuring is niet verbruikt.',
          'Draai het commando opnieuw als je verder wilt; je hoeft niets op te ruimen.',
        ].join('\n'),
      );
    }

    current = await client.requestAuthorization(request);
    write(
      [
        'Deze code is verlopen. Nieuwe code aanvragen...',
        `Open: ${current.verificationUri}`,
        `Bevestigingscode: ${current.userCode}`,
        `Geldig tot ${new Date(current.expiresAt).toISOString()} (nog ${formatDuration(current.expiresAt - now())}); de CLI wacht nog ${formatDuration(deadline - now())}.`,
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
  waitBudgetMs = WAIT_BUDGET_MS,
  credentials = {
    export: exportRegistryCredentials,
    import: importRegistryCredentials,
    doctor: registryDoctor,
  },
} = {}) {
  const parsed = parseArgs(argv, cwd);
  if (parsed.help) { write(HELP); return { kind: 'help' }; }
  if (parsed.version) { write(`${version}\n`); return { kind: 'version' }; }
  if (isReservedRelease(version)) { write(RESERVED_NOTICE); return { kind: 'unavailable' }; }

  if (parsed.command === 'doctor') {
    const report = await credentials.doctor({ projectPath: parsed.projectPath });
    write(report.report);
    return { kind: 'doctor', ok: report.ok };
  }

  if (parsed.command === 'export') {
    const exported = await credentials.export({
      projectPath: parsed.projectPath,
      destination: parsed.file,
    });
    write(
      [
        `Registry-token weggeschreven naar ${exported.destination} (modus 0600).`,
        'Kopieer dit bestand naar de tweede machine en importeer het daar met:',
        `  npx create-tetra --import-credentials ${basename(exported.destination)}`,
        'Verwijder het daarna op beide machines en zet het niet in git; er staat een token in.',
        '',
      ].join('\n'),
    );
    return { kind: 'exported', ...exported };
  }

  if (parsed.command === 'import') {
    const imported = await credentials.import({ source: parsed.file });
    write(
      [
        `Registry-token opgeslagen in ${imported.path}.`,
        `npm ci kan nu de @soulbatical-packages ophalen met ${imported.authKey}.`,
        'Verwijder het geïmporteerde bestand nu: er staat een token in.',
        '',
      ].join('\n'),
    );
    return { kind: 'imported', ...imported };
  }

  const directoryName = basename(parsed.projectPath) || 'tetra-app';
  let projectName;
  let derivedFrom = null;

  if (parsed.name !== undefined) {
    projectName = parsed.name;
  } else if (projectNameProblem(directoryName) === null) {
    projectName = directoryName;
  } else {
    projectName = slugFromDirectory(directoryName) ?? directoryName;
    derivedFrom = directoryName;
  }

  const nameProblem = projectNameProblem(projectName);
  if (nameProblem) {
    throw new Error(
      derivedFrom
        ? `${nameProblem}\nKies zelf een geldige naam met: npx create-tetra . --name <naam>`
        : nameProblem,
    );
  }

  write(`Tetra\nProject: ${projectName}${derivedFrom ? ` (afgeleid van de mapnaam "${derivedFrom}")` : ''}\n`);
  if (derivedFrom) write('Gebruik --name <naam> om een andere projectnaam te kiezen.\n');
  write('\n');

  // Before anything else: a target we cannot use must not cost the customer an
  // approval. A grant is single-use, so failing after it is spent means they
  // have to start over for a mistake we could see up front.
  if (!(await checkDirectory(parsed.projectPath))) {
    throw new Error(directoryInUse(parsed.projectPath));
  }

  const authorizationRequest = { action: 'install', project: { name: projectName }, targets: parsed.targets };

  write('Goedkeuring aanvragen...\n');
  const authorization = await client.requestAuthorization(authorizationRequest);
  const deadline = now() + waitBudgetMs;
  write(`Open: ${authorization.verificationUri}\n`);
  write(`Bevestigingscode: ${authorization.userCode}\n`);
  write(`Geldig tot ${new Date(authorization.expiresAt).toISOString()} (nog ${formatDuration(authorization.expiresAt - now())}).\n`);
  browser(authorization.verificationUri, { write });
  write(waitingInstructions(deadline, now));
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
    budgetMs: waitBudgetMs,
  });

  write('Goedgekeurd.\n');
  let claim;
  try {
    claim = await client.claim(status.installGrant);
  } catch (error) {
    // claim() is deliberately never retried (it spends a single-use grant),
    // so any failure here — including the network blip waitForApproval just
    // spent hours surviving on the poll side — ends the run. Said plainly:
    // this is not "the install failed", it is "the approval you just gave
    // cannot be used (again)" — which needs a different next step, and one an
    // AI assistant must not confuse with "restart and wait again".
    // Deliberately not claiming the grant *was* spent: a connection that
    // never reached the control plane at all never spent anything, and this
    // message has no way to tell the two apart.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `Mislukt na goedkeuring: je goedkeuring is binnengekomen, maar het ophalen van je toegang is mislukt: ${reason}`,
        'Die goedkeuring kan niet opnieuw gebruikt worden. Draai het commando opnieuw om een nieuwe aan te vragen.',
      ].join('\n'),
      { cause: error },
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
  if (run.kind === 'doctor' && run.ok === false) process.exitCode = 1;
  if (run.kind === 'installed' && run.project.installed === false) process.exitCode = 1;
}

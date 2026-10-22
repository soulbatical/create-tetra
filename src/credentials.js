// A second machine has the project checkout but not the registry token: that
// token was written into the user-level npmrc of the machine where create-tetra
// ran. npm then asks the registry without credentials, and the registry answers
// `E404 Project not found` -- a 404, because a private registry hides a package
// it will not authenticate you for. That is indistinguishable from a wrong URL
// unless someone explains it, which is what the doctor does.
//
// The transfer itself is deliberately local and server-free: the token already
// exists on the first machine, so copying it is an export/import, not a new
// approval. That also keeps the single-use grant single-use.
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ALLOWED_REGISTRY_HOSTS, SCAFFOLDER_SCOPE, authKeyFor } from './claim.js';
import { resolveUserConfigPath, storeRegistryCredential } from './scaffold.js';

export const CREDENTIALS_FILE_KIND = 'create-tetra-registry-credentials';
export const CREDENTIALS_FILE_VERSION = 1;

const SCOPE = SCAFFOLDER_SCOPE;
const PLACEHOLDER_TOKEN = '${NPM_TOKEN}';
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readIfPresent(read, path) {
  try {
    return await read(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function canonicalRegistryUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

// The project .npmrc is the authority on which registry this project uses. We
// deliberately do not infer one from the allowlist: npm.pkg.github.com and
// gitlab.com host other organisations' packages too, and exporting the wrong
// token is worse than refusing.
export function registryUrlFromProjectNpmrc(content) {
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const prefix = `${SCOPE}:registry=`;
    if (!line.startsWith(prefix)) continue;
    try {
      const url = canonicalRegistryUrl(line.slice(prefix.length));
      // The token we are about to find is a credential; the registry it belongs
      // to must be the HTTPS one create-tetra writes, not whatever a cloned
      // .npmrc happens to name.
      if (url.protocol !== 'https:') throw new Error('not HTTPS');
      return url;
    } catch {
      throw new Error(`De ${SCOPE}:registry-regel in .npmrc is geen geldige HTTPS-registry-URL.`);
    }
  }
  return null;
}

// npm accepts the key with or without a trailing slash and prefers the
// trailing-slash form. Check both so a token written by npm itself is found.
export function findRegistryCredential(npmrc, authKey) {
  const base = authKey.replace(/\/$/, '');
  const keys = new Set([`${base}/`, base]);
  for (const raw of String(npmrc).split('\n')) {
    const line = raw.trim();
    const marker = line.indexOf(':_authToken=');
    if (marker < 0) continue;
    if (!keys.has(line.slice(0, marker))) continue;
    const token = line.slice(marker + ':_authToken='.length).trim();
    // A literal ${NPM_TOKEN} is a placeholder for a build machine, not a token
    // npm can use here; treating it as present would make the doctor lie.
    if (token === '' || token === PLACEHOLDER_TOKEN) return null;
    return token;
  }
  return null;
}

// An imported file is data from another machine, not something this process
// wrote, so it gets the same treatment as a control-plane claim: the host is
// pinned and the value may not span a line.
export function parseAuthKey(authKey, { allowedHosts = ALLOWED_REGISTRY_HOSTS } = {}) {
  if (typeof authKey !== 'string' || authKey.length < 4 || authKey.length > 2048 || !authKey.startsWith('//')) {
    throw new Error('Het credentials-bestand bevat een ongeldige registry-sleutel.');
  }
  if (UNPRINTABLE.test(authKey) || /\s/.test(authKey)) {
    throw new Error('Het credentials-bestand bevat een registry-sleutel met ongeldige tekens.');
  }
  const rest = authKey.slice(2);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new Error('Het credentials-bestand bevat een ongeldige registry-sleutel.');
  const host = rest.slice(0, slash).split(':')[0].toLowerCase();
  if (!allowedHosts.has(host)) {
    throw new Error(`Het credentials-bestand wijst naar een onverwachte host (${host}).`);
  }
  return { authKey, host };
}

function requireToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    throw new Error('Het credentials-bestand bevat geen geldig token.');
  }
  if (UNPRINTABLE.test(token) || /\s/.test(token)) {
    throw new Error('Het credentials-bestand bevat een token met ongeldige tekens.');
  }
  if (token === PLACEHOLDER_TOKEN) {
    throw new Error('Het credentials-bestand bevat de placeholder ${NPM_TOKEN}, geen echte token.');
  }
  return token;
}

const TRANSFER_STEPS = (projectPath) => [
  'Zo zet je hem over van de machine waar create-tetra werkte:',
  '  1. Daar:',
  `       npx create-tetra --export-credentials tetra-credentials.json ${projectPath}`,
  '  2. Kopieer dat bestand naar deze machine (bijvoorbeeld met scp).',
  '  3. Hier:',
  '       npx create-tetra --import-credentials tetra-credentials.json',
  '       rm tetra-credentials.json',
  '',
  'Handmatig kan ook: neem de regel `//<registry>/:_authToken=...` over uit de',
  'npmrc op je eerste machine en zet hem in je gebruikers-npmrc.',
];

export async function exportRegistryCredentials({
  projectPath = process.cwd(),
  destination,
  userConfigPath = resolveUserConfigPath(),
  read = readFile,
  write = writeFile,
  setMode = chmod,
} = {}) {
  if (!destination) {
    throw new Error('Geef een bestand op: npx create-tetra --export-credentials <bestand> [project-map].');
  }

  const projectNpmrcPath = join(projectPath, '.npmrc');
  const registryUrl = registryUrlFromProjectNpmrc(await readIfPresent(read, projectNpmrcPath));
  if (!registryUrl) {
    throw new Error(
      [
        `Geen .npmrc met een ${SCOPE}:registry-regel gevonden in ${projectNpmrcPath}.`,
        'Draai dit in de map van je project (of geef die map mee), zodat duidelijk is',
        'welke registry-token je wilt exporteren.',
        '',
        ...TRANSFER_STEPS(projectPath),
      ].join('\n'),
    );
  }

  const authKey = authKeyFor(registryUrl);
  const host = authKey.slice(2).split('/')[0].split(':')[0].toLowerCase();
  if (!ALLOWED_REGISTRY_HOSTS.has(host)) {
    throw new Error(`De registry in ${projectNpmrcPath} wijst naar een onverwachte host (${host}).`);
  }
  const token = findRegistryCredential(await readIfPresent(read, userConfigPath), authKey);
  if (!token) {
    throw new Error(
      [
        `Geen registry-token gevonden voor ${authKey} in ${userConfigPath}.`,
        'Op deze machine heeft create-tetra nog geen token opgeslagen, of je npm-config',
        'staat ergens anders. Draai eerst `npx create-tetra --doctor` om te zien wat er',
        'ontbreekt.',
        '',
        ...TRANSFER_STEPS(projectPath),
      ].join('\n'),
    );
  }

  const document = {
    kind: CREDENTIALS_FILE_KIND,
    version: CREDENTIALS_FILE_VERSION,
    registry: { auth_key: authKey, token },
  };
  const content = `${JSON.stringify(document, null, 2)}\n`;
  await write(destination, content, { mode: 0o600 });
  // writeFile leaves the mode of an existing file alone, so set it explicitly:
  // this file holds a credential and may not be readable by anyone else.
  await setMode(destination, 0o600);

  return { destination, authKey };
}

export async function importRegistryCredentials({
  source,
  userConfigPath = resolveUserConfigPath(),
  read = readFile,
  storeCredential = storeRegistryCredential,
  allowedHosts = ALLOWED_REGISTRY_HOSTS,
} = {}) {
  if (!source) {
    throw new Error('Geef een bestand op: npx create-tetra --import-credentials <bestand>.');
  }

  let document;
  try {
    document = JSON.parse(await read(source, 'utf8'));
  } catch {
    // The parser's own message can quote the offending input, and that input is
    // a credential file. Say what is wrong without echoing any of it.
    throw new Error(`Kon ${source} niet lezen als create-tetra-credentials-bestand.`);
  }

  if (!isRecord(document) || document.kind !== CREDENTIALS_FILE_KIND) {
    throw new Error(`${source} is geen create-tetra-credentials-bestand.`);
  }
  if (document.version !== CREDENTIALS_FILE_VERSION) {
    throw new Error(`${source} heeft versie ${document.version}; deze create-tetra leest versie ${CREDENTIALS_FILE_VERSION}.`);
  }
  if (!isRecord(document.registry)) {
    throw new Error(`${source} bevat geen registry-gegevens.`);
  }

  const { authKey } = parseAuthKey(document.registry.auth_key, { allowedHosts });
  const token = requireToken(document.registry.token);
  const path = await storeCredential({ authKey, token }, { path: userConfigPath });

  return { path, authKey };
}

export async function registryDoctor({
  projectPath = process.cwd(),
  userConfigPath = resolveUserConfigPath(),
  read = readFile,
  allowedHosts = ALLOWED_REGISTRY_HOSTS,
} = {}) {
  const projectNpmrcPath = join(projectPath, '.npmrc');
  const registryUrl = registryUrlFromProjectNpmrc(await readIfPresent(read, projectNpmrcPath));
  const userNpmrc = await readIfPresent(read, userConfigPath);

  const problems = [];
  const warnings = [];
  const lines = [];

  if (!registryUrl) {
    problems.push('missing-project-npmrc');
    lines.push(
      `Geen .npmrc met een ${SCOPE}:registry-regel in ${projectNpmrcPath}.`,
      'Draai dit in de map van je project (of geef die map mee).',
      '',
      ...TRANSFER_STEPS(projectPath),
    );
  } else {
    const authKey = authKeyFor(registryUrl);
    const token = findRegistryCredential(userNpmrc, authKey);

    if (token) {
      lines.push(
        `Registry-token gevonden voor ${authKey} in ${userConfigPath}.`,
        'Deze machine kan de @soulbatical-packages ophalen.',
      );
    } else {
      problems.push('missing-registry-token');
      lines.push(
        `Geen registry-token voor ${authKey} in ${userConfigPath}.`,
        '',
        'Dat is de oorzaak van `E404 Project not found` bij `npm ci`. Dat is geen auth-fout',
        'en je registry-URL is niet verkeerd: de registry verbergt projecten',        'waarvoor je geen token meestuurt achter een 404, zodat je niet kunt aftasten',
        'welke projecten bestaan. De tokenregel ontbreekt dus op deze machine.',
        '',
        ...TRANSFER_STEPS(projectPath),
      );
    }

    const ciNpmrc = await readIfPresent(read, join(projectPath, 'ci', 'npmrc'));
    if (ciNpmrc.includes(':_authToken=')) {
      lines.push(
        '',
        'CI zonder ~/.npmrc: ci/npmrc bestaat. Zet daar NPM_TOKEN als build-variabele;',
        'dat bestand geeft de placeholder uit en niets anders leest hem.',
      );
    } else {
      warnings.push('missing-ci-npmrc');
      lines.push(
        '',
        'Let op: ci/npmrc ontbreekt of heeft geen tokenregel. Een buildmachine zonder',
        '~/.npmrc leest dat bestand; zonder het bestand wordt de deploy een 401.',
      );
    }

    lines.push('', `Opnieuw controleren: npx create-tetra --doctor ${projectPath}`);
  }

  // Parsing the key is also a check: a project .npmrc with a registry host we do
  // not control should not pass as healthy.
  const authKey = registryUrl ? authKeyFor(registryUrl) : null;
  if (authKey) {
    try {
      parseAuthKey(authKey, { allowedHosts });
    } catch (error) {
      problems.push('unexpected-registry-host');
      lines.push('', error.message);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    report: `${lines.join('\n')}\n`,
    authKey,
    projectPath,
    userConfigPath,
  };
}

import { spawn } from 'node:child_process';

const APPROVAL_ORIGIN = 'https://www.tetrasaas.com';

export function openBrowser(url, { platform = process.platform, spawnImpl = spawn, origin = APPROVAL_ORIGIN } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
    throw new Error('Refusing to open an untrusted browser URL.');
  }
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', parsed.toString()] : [parsed.toString()];
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', shell: false });
  child.unref();
}

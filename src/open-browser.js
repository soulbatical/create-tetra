import { spawn } from 'node:child_process';

export function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.origin !== 'https://app.tetrasaas.com') {
    throw new Error('Refusing to open an untrusted browser URL.');
  }
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', parsed.toString()] : [parsed.toString()];
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', shell: false });
  child.unref();
}

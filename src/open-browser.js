import { spawn } from 'node:child_process';

const APPROVAL_ORIGIN = 'https://www.tetrasaas.com';

export function openBrowser(url, { platform = process.platform, spawnImpl = spawn, origin = APPROVAL_ORIGIN } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
    throw new Error('Refusing to open an untrusted browser URL.');
  }
  // Not `cmd /c start`: cmd.exe re-parses its own command line, where `&` is a
  // command separator, and Node does not escape that when cmd is the explicit
  // target. A URL is attacker-influenced input here, so use a handler that
  // takes the URL as a plain argument instead.
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = platform === 'win32'
    ? ['url.dll,FileProtocolHandler', parsed.toString()]
    : [parsed.toString()];
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', shell: false });
  // No opener exists on a headless Linux box, WSL without xdg-utils, or a bare
  // container. Without a listener that spawn failure is an uncaught exception
  // that kills the process — and the URL and the confirmation code have already
  // been printed, so the customer can simply open it himself.
  child.on?.('error', () => {});
  child.unref?.();
}

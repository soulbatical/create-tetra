import { spawn } from 'node:child_process';

const APPROVAL_ORIGIN = 'https://tetrasaas.com';

export function openBrowser(url, {
  platform = process.platform,
  spawnImpl = spawn,
  origin = APPROVAL_ORIGIN,
  write = (text) => process.stdout.write(text),
} = {}) {
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
  // container. A spawn failure arrives as an event, not a throw, and an 'error'
  // event without a listener is an uncaught exception that takes the process
  // down — past `main().catch()`, which only sees rejected promises.
  //
  // Surviving it silently is only half the fix. The customer would watch for a
  // browser that never appears while the CLI waits for an approval he has no
  // idea he still has to give. The URL and the confirmation code are already on
  // screen one line up, so point him at them.
  child.on?.('error', () => {
    write('Kon de browser niet automatisch openen; open de link hierboven zelf.\n');
  });
  child.unref?.();
}

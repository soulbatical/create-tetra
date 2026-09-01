import assert from 'node:assert/strict';
import test from 'node:test';

import { openBrowser } from '../src/open-browser.js';

const refuse = () => { throw new Error('spawned'); };

test('only the allowlisted approval origin is opened', () => {
  for (const url of [
    'http://www.tetrasaas.com/install/approve',
    'https://www.tetrasaas.com.evil.example/install',
    'https://evil.example/install',
    'https://tetrasaas.com/install/approve',
  ]) {
    assert.throws(
      () => openBrowser(url, { platform: 'darwin', spawnImpl: refuse }),
      /untrusted/,
      `expected ${url} to be refused`,
    );
  }
});

test('the url is passed as an argument, never through a shell', () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() {} };
  };
  const url = 'https://www.tetrasaas.com/install/approve?request=abc';

  openBrowser(url, { platform: 'darwin', spawnImpl });
  openBrowser(url, { platform: 'win32', spawnImpl });
  openBrowser(url, { platform: 'linux', spawnImpl });

  assert.deepEqual(calls.map(({ command }) => command), ['open', 'rundll32', 'xdg-open']);
  assert.deepEqual(calls[1].args, ['url.dll,FileProtocolHandler', url]);
  for (const call of calls) {
    assert.equal(call.options.shell, false);
    assert.ok(call.args.includes(url));
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { openBrowser } from '../src/open-browser.js';

const refuse = () => { throw new Error('spawned'); };

test('only the allowlisted approval origin is opened', () => {
  for (const url of [
    'http://tetrasaas.com/install/approve',
    'https://tetrasaas.com.evil.example/install',
    'https://evil.example/install',
    'https://www.tetrasaas.com/install/approve',
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
  const url = 'https://tetrasaas.com/install/approve?request=abc';

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

// A headless Linux box, WSL without xdg-utils or a bare container has no opener.
// Without an error listener that spawn failure is an uncaught exception, and it
// would kill the CLI right after printing the URL the customer still needs.
test('a missing browser opener does not take the process down', () => {
  const listeners = [];
  const spawnImpl = () => ({
    on(event, handler) { listeners.push({ event, handler }); },
    unref() {},
  });

  openBrowser('https://tetrasaas.com/install/approve', { platform: 'linux', spawnImpl });

  const errorListener = listeners.find(({ event }) => event === 'error');
  assert.ok(errorListener, 'the child must have an error listener');
  assert.doesNotThrow(() => errorListener.handler(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
});

// Surviving the failure is not enough: the customer sees a browser that never
// opens and has no way to know the flow is still waiting for him. The URL and
// the confirmation code are already on screen, so say to use them.
test('a missing browser opener tells the customer to open the link himself', () => {
  const output = [];
  let fail;
  const spawnImpl = () => ({
    on(event, handler) { if (event === 'error') fail = handler; },
    unref() {},
  });

  openBrowser('https://tetrasaas.com/install/approve', {
    platform: 'linux',
    spawnImpl,
    write: (text) => output.push(text),
  });

  assert.deepEqual(output, [], 'nothing is said while the opener may still succeed');
  fail(Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }));

  const notice = output.join('');
  assert.match(notice, /browser/i, 'the notice must name what failed');
  assert.match(notice, /zelf|hierboven/i, 'the notice must point back at the link above');
  assert.equal(notice.endsWith('\n'), true, 'the notice is a whole line');
});

// A second failure event must not repeat the line, and the notice must not be a
// hard dependency: called without a write channel it still must not throw.
test('the opener notice is printed once and needs no write channel', () => {
  let fail;
  const spawnImpl = () => ({
    on(event, handler) { if (event === 'error') fail = handler; },
    unref() {},
  });

  assert.doesNotThrow(() => {
    openBrowser('https://tetrasaas.com/install/approve', { platform: 'linux', spawnImpl });
    fail(new Error('spawn ENOENT'));
  });
});

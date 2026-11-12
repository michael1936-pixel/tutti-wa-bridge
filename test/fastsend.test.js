import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The stuck sign and the renew, read from session.js (it has side effects on import).
const src = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
const pick = (name) => {
  const i = src.indexOf(`function ${name}(`);
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  return src.slice(i, j + 1);
};
const STUCK_SOCKET = { windowMs: 60_000 };
const logs = [];
const logger = { warn: (o, m) => logs.push(m), error: () => {} };
const emitEvent = () => {};
const stuckSignOf = new Function('STUCK_SOCKET', `${pick('stuckSignOf')}; return stuckSignOf;`)(STUCK_SOCKET);
const renewStuckNow = new Function('logger', 'emitEvent', `${pick('renewStuckNow')}; return renewStuckNow;`)(logger, emitEvent);

test('one recent query timeout is a stuck sign; an old one is not', () => {
  const now = Date.now();
  assert.equal(stuckSignOf({ timeouts: [now - 10_000] }, now), true);
  assert.equal(stuckSignOf({ timeouts: [now - 120_000] }, now), false);
  assert.equal(stuckSignOf({ timeouts: [] }, now), false);
  assert.equal(stuckSignOf(null, now), false);
});

test('a send renews a stuck socket at once, at most once a minute', () => {
  let ended = 0;
  const s = { phone: '972500000000', sock: { end: () => { ended++; } }, health: { timeouts: [Date.now()] } };
  renewStuckNow(s, 'send');
  renewStuckNow(s, 'send');
  assert.equal(ended, 1);
  assert.deepEqual(s.health.timeouts, []);
  assert.ok(logs.includes('session_stuck_renew_on_send'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeAskerProbe, makeTtlCache } from '../retryMode.js';

// 2026-11-24: who asks for a group post again, and is his device on the cached list
// the post's key went to (Baileys sends the group's key only to the cached devices).

function cacheWith(entries, { now } = {}) {
  const c = makeTtlCache({ ttlMs: 60 * 60_000, now });
  for (const [user, devices] of Object.entries(entries)) c.set(user, devices.map((device) => ({ user, device })));
  return c;
}

test('a device on its member\'s cached list, one not on it, and a member with no list kept', () => {
  const p = makeAskerProbe();
  const devicesCache = cacheWith({ '111': [0, 2], '222': [0] });
  p.note({ participant: '111:2@lid', devicesCache, answered: false }); // listed (a linked device)
  p.note({ participant: '222:7@lid', devicesCache, answered: false }); // not listed: a new device
  p.note({ participant: '333@lid', devicesCache, answered: true });    // nothing kept for him
  const s = p.stats();
  assert.equal(s.asks, 3);
  assert.equal(s.listed, 1);
  assert.equal(s.not_listed, 1);
  assert.equal(s.no_list, 1);
  assert.equal(s.lid, 3);
  assert.equal(s.phone, 1);
  assert.equal(s.linked, 2);
  assert.equal(s.answered, 1);
  assert.equal(s.refused, 2);
});

test('a group of phone numbers: the list is found under his number (via_pn)', () => {
  const p = makeAskerProbe();
  const devicesCache = cacheWith({ '972501234567': [0, 1] });
  p.note({ participant: '999:1@lid', altParticipant: '972501234567:1@s.whatsapp.net', devicesCache });
  p.note({ participant: '999:4@lid', altParticipant: '972501234567:4@s.whatsapp.net', devicesCache });
  const s = p.stats();
  assert.equal(s.via_pn, 2);
  assert.equal(s.listed, 1);
  assert.equal(s.not_listed, 1);
  assert.equal(s.no_list, 0);
});

test('one who asks again and again while not on the list: counted, and shown by the last 4 digits only', () => {
  let t = 1_000_000;
  const now = () => t;
  const p = makeAskerProbe({ now });
  const devicesCache = cacheWith({ '123456789': [0] }, { now });
  t += 20 * 60_000; // the list is 20 minutes old
  for (let i = 0; i < 7; i++) { p.note({ participant: '123456789:3@lid', devicesCache }); t += 60_000; }
  p.note({ participant: '123456789@lid', devicesCache }); // his phone, once, on the list
  const s = p.stats();
  assert.equal(s.repeat.devices, 2);
  assert.equal(s.repeat.once, 1);
  assert.equal(s.repeat.six_plus, 1);
  assert.equal(s.repeat.six_plus_not_listed, 1);
  assert.equal(s.not_listed_list_age_min_p50, 23);
  assert.equal(s.top[0].asks, 7);
  assert.equal(s.top[0].not_listed, 7);
  assert.equal(s.top[0].jid, '…6789:3@lid');
  assert.ok(!JSON.stringify(s).includes('123456789'), 'no full number in /diag');
});

test('asks older than the window are not counted as repeats', () => {
  let t = 0;
  const p = makeAskerProbe({ now: () => t, windowMs: 60 * 60_000 });
  const devicesCache = cacheWith({ '1': [0] }, { now: () => t });
  p.note({ participant: '1:5@lid', devicesCache });
  t += 2 * 60 * 60_000;
  assert.equal(p.stats().repeat.devices, 0);
  p.note({ participant: '1:5@lid', devicesCache });
  assert.equal(p.stats().repeat.once, 1);
});

test('the cache says how old a kept value is', () => {
  let t = 0;
  const c = makeTtlCache({ ttlMs: 10_000, now: () => t });
  c.set('a', [1]);
  t = 4_000;
  assert.equal(c.ageMs('a'), 4_000);
  t = 11_000;
  assert.equal(c.ageMs('a'), null);
  assert.equal(c.ageMs('missing'), null);
});

test('a broken cache never stops an ask from being counted', () => {
  const p = makeAskerProbe();
  p.note({ participant: '5:1@lid', devicesCache: { get() { throw new Error('x'); } } });
  assert.equal(p.stats().no_list, 1);
});

test('wired: every group ask - answered or refused - goes to the probe, and /diag shows it', () => {
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes("if (kind === 'group' && !own) probeAsk(s, key, true);"));
  assert.ok(session.includes("if (kind === 'group') probeAsk(s, key, false);"));
  assert.ok(session.includes('askers: s.askerProbe ? { ...s.askerProbe.stats(), devicesTtlMin: DEVICES_TTL_MS / 60_000 } : null,'));
  assert.ok(session.includes('s.askerProbe = s.askerProbe || makeAskerProbe();'));
});

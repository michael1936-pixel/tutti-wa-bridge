import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GROUP_PER_MINUTE, RETRY_RULES, isOwnParticipant, makeRetryCounter, parseGroupLimit, retryVerdict } from '../retryGuard.js';
import { parseMode } from '../retryMode.js';

// 2026-11-15: "בהמתנה להודעה זו" — most members who asked for a post again were refused by the 30-a-minute limit.

test('group limit: a whole number inside the bounds, the base when none is given', () => {
  assert.equal(RETRY_RULES.group.perMinute, 30);
  assert.equal(parseGroupLimit(undefined), 30);
  assert.equal(parseGroupLimit(''), 30);
  assert.equal(parseGroupLimit(true), 30);
  assert.equal(parseGroupLimit('abc', 90), 90);
  assert.equal(parseGroupLimit(120), 120);
  assert.equal(parseGroupLimit('90.4'), 90);
  assert.equal(parseGroupLimit(5), GROUP_PER_MINUTE.min);
  assert.equal(parseGroupLimit(99999), GROUP_PER_MINUTE.max);
});

test('group limit: set while running — the same counter answers by the new limit', () => {
  let t = 1_000_000;
  const rules = { group: { ...RETRY_RULES.group, perMinute: 2 }, private: { ...RETRY_RULES.private } };
  const skipped = [];
  const c = makeRetryCounter({
    ourMessage: () => ({ ts: t - 1000, group: true }),
    onSkip: (why) => skipped.push(why),
    rules,
    now: () => t,
  });
  assert.equal(c.get('m1:a'), undefined);
  assert.equal(c.get('m1:b'), undefined);
  assert.equal(c.get('m1:c'), 99); // the third in the minute: refused
  assert.deepEqual(skipped, ['too_many']);
  rules.group.perMinute = 10; // raised while running
  assert.equal(c.get('m1:d'), undefined);
  assert.equal(c.get('m1:e'), undefined);
});

test('group limit: it rides with the mode and never changes it', () => {
  assert.deepEqual(parseMode({ groupPerMinute: 120 }, { keepGroupMemory: true, referenceStanza: true, phonesToParticipant: false }),
    { keepGroupMemory: true, referenceStanza: true, phonesToParticipant: false });
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(server.includes("JSON.stringify({ ...mode, groupPerMinute, forgetRefused, stopLoops })"));
  assert.ok(server.includes("w.child.send({ t: 'retry_mode', mode, groupPerMinute, forgetRefused, stopLoops })"));
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes('rules: retryRules,'));
  const worker = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.ok(worker.includes('if (m.groupPerMinute != null) setRetryLimit(m.groupPerMinute);'));
});


// 2026-11-18: his own post stood on his own phone as "בהמתנה להודעה זו" — the
// minute's limit refused his phone with the rest; and the same devices asked
// again on every post, since a refused device is never healed.

test('own devices: his phone and his LID are his; a member is not', () => {
  const me = { id: '972587115623:12@s.whatsapp.net', lid: '123456789012345:12@lid' };
  assert.equal(isOwnParticipant('972587115623:0@s.whatsapp.net', me), true);
  assert.equal(isOwnParticipant('972587115623@s.whatsapp.net', me), true);
  assert.equal(isOwnParticipant('123456789012345:0@lid', me), true);
  assert.equal(isOwnParticipant('972501234567:3@s.whatsapp.net', me), false);
  assert.equal(isOwnParticipant('972587115623:0@s.whatsapp.net', null), false);
  assert.equal(isOwnParticipant('', me), false);
});

test('own device: answered outside the minute limit, and not counted in it', () => {
  let t = 1_000_000;
  const rules = { group: { ...RETRY_RULES.group, perMinute: 1 }, private: { ...RETRY_RULES.private } };
  const skipped = [];
  const allowed = [];
  const sentAt = t - 1000;
  const c = makeRetryCounter({
    ourMessage: () => ({ ts: sentAt, group: true }),
    onSkip: (why) => skipped.push(why),
    onAllow: (key, kind, own) => allowed.push([key, own]),
    isOwn: (p) => p.startsWith('972587115623:'),
    rules,
    now: () => t,
  });
  assert.equal(c.get('m1:972501234567:0@s.whatsapp.net'), undefined); // the minute's one
  assert.equal(c.get('m1:972587115623:0@s.whatsapp.net'), undefined); // his phone: always
  assert.equal(c.get('m2:972587115623:0@s.whatsapp.net'), undefined);
  assert.equal(c.get('m1:972509999999:0@s.whatsapp.net'), 99); // a member: the minute is spent
  assert.deepEqual(skipped, ['too_many']);
  assert.deepEqual(allowed.map((a) => a[1]), [false, true, true]);
  // Too old is too old for him as well.
  t += 20 * 60_000;
  assert.equal(c.get('m3:972587115623:0@s.whatsapp.net'), 99);
  assert.deepEqual(skipped, ['too_many', 'too_old']);
});

test('per asker: a device gets its two in the window, then waits — the minute serves the others', () => {
  let t = 1_000_000;
  const rules = { group: { ...RETRY_RULES.group, perMinute: 100, perAsker: { count: 2, windowMs: 10 * 60_000 } }, private: { ...RETRY_RULES.private } };
  const skipped = [];
  const c = makeRetryCounter({
    ourMessage: () => ({ ts: t - 1000, group: true }),
    onSkip: (why) => skipped.push(why),
    rules,
    now: () => t,
  });
  const dev = '972501234567:3@s.whatsapp.net';
  assert.equal(c.get(`m1:${dev}`), undefined);
  t += 1000;
  assert.equal(c.get(`m2:${dev}`), undefined);
  t += 1000;
  assert.equal(c.get(`m3:${dev}`), 99);
  assert.equal(c.get('m3:972509999999:0@s.whatsapp.net'), undefined); // another member still goes
  assert.deepEqual(skipped, ['too_often']);
  t += 10 * 60_000;
  assert.equal(c.get(`m4:${dev}`), undefined); // the window passed
});

test('verdict order: too old, own, too often, too many', () => {
  const r = { group: { maxAgeMs: 1000, perMinute: 1, perAsker: { count: 1, windowMs: 1000 } }, private: RETRY_RULES.private };
  assert.equal(retryVerdict({ ageMs: 2000, group: true, recentCount: 0, own: true }, r), 'too_old');
  assert.equal(retryVerdict({ ageMs: 10, group: true, recentCount: 5, askerCount: 5, own: true }, r), 'ok');
  assert.equal(retryVerdict({ ageMs: 10, group: true, recentCount: 0, askerCount: 1 }, r), 'too_often');
  assert.equal(retryVerdict({ ageMs: 10, group: true, recentCount: 1, askerCount: 0 }, r), 'too_many');
  assert.equal(retryVerdict({ ageMs: 10, group: false, recentCount: 0, askerCount: 9 }, r), 'ok');
});

test('the session answers its own devices and shows it in /diag', () => {
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes("isOwn: (participant) => isOwnParticipant(participant, s.sock?.authState?.creds?.me),"));
  assert.ok(session.includes('ownAnswered: s.retryOwnAnswered || 0,'));
  assert.ok(/const BRIDGE_BUILD = '[a-z0-9-]+-2026-\d\d-\d\d'/.test(session));
});

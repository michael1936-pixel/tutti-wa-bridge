import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GROUP_PER_MINUTE, RETRY_RULES, makeRetryCounter, parseGroupLimit } from '../retryGuard.js';
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
  assert.ok(server.includes("JSON.stringify({ ...mode, groupPerMinute, forgetRefused })"));
  assert.ok(server.includes("w.child.send({ t: 'retry_mode', mode, groupPerMinute, forgetRefused })"));
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes('rules: retryRules,'));
  const worker = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.ok(worker.includes('if (m.groupPerMinute != null) setRetryLimit(m.groupPerMinute);'));
});

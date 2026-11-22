import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forgetAskers, makeRefusedAskers, makeHealer } from '../retryMode.js';
import { makeRetryCounter, RETRY_RULES } from '../retryGuard.js';

// 2026-11-15, "בהמתנה להודעה זו": a member refused a resend stayed marked as holding the group's key.

function fakeKeys(memory, { tx = false } = {}) {
  const sets = [];
  const txKeys = [];
  const keys = {
    sets, txKeys, memory,
    get: async (type, ids) => (type === 'sender-key-memory' ? Object.fromEntries(ids.filter((id) => memory[id]).map((id) => [id, { ...memory[id] }])) : {}),
    set: async (data) => { sets.push(data); for (const [g, v] of Object.entries(data['sender-key-memory'] || {})) { if (v == null) delete memory[g]; else memory[g] = v; } },
  };
  if (tx) keys.transaction = async (work, key) => { txKeys.push(key); return work(); };
  return keys;
}

test('refused askers: gathered by group, each device once, taken and started anew', () => {
  const r = makeRefusedAskers({ maxPerGroup: 2 });
  assert.equal(r.size, 0);
  r.note('g1@g.us', '111:2@lid');
  r.note('g1@g.us', '111:2@lid');
  r.note('g1@g.us', '222@lid');
  r.note('g1@g.us', '333@lid'); // over the cap: left for his next ask
  r.note('g2@g.us', '972501111111@s.whatsapp.net');
  r.note('', 'x');
  r.note('g3@g.us', '');
  const got = r.take();
  assert.deepEqual([...got.keys()], ['g1@g.us', 'g2@g.us']);
  assert.deepEqual([...got.get('g1@g.us')], ['111:2@lid', '222@lid']);
  assert.equal(r.size, 0);
});

test('forgetAskers: every device of each asker in one write, nobody else, inside the numbers transaction', async () => {
  const keys = fakeKeys({
    'g@g.us': {
      '111@lid': true, '111:4@lid': true, '972501111111:4@s.whatsapp.net': true,
      '222:1@lid': true, '333@lid': true, '972503333333@s.whatsapp.net': true,
    },
  }, { tx: true });
  const lidMapping = {
    getPNForLID: async (lid) => (lid.startsWith('111') ? '972501111111@s.whatsapp.net' : null),
    getLIDForPN: async () => { throw new Error('WhatsApp must not be asked'); },
  };
  const dropped = await forgetAskers({ keys, group: 'g@g.us', participants: ['111:4@lid', '222:1@lid', '972509999999@s.whatsapp.net'], lidMapping, txKey: 'me@s.whatsapp.net' });
  assert.equal(dropped, 4);
  assert.deepEqual(keys.memory['g@g.us'], { '333@lid': true, '972503333333@s.whatsapp.net': true });
  assert.equal(keys.sets.length, 1);
  assert.deepEqual(keys.txKeys, ['me@s.whatsapp.net']);
});

test('forgetAskers: nothing remembered or nobody of theirs — no write; a mapping that fails still forgets the LID', async () => {
  const none = fakeKeys({});
  assert.equal(await forgetAskers({ keys: none, group: 'g@g.us', participants: ['111@lid'] }), 0);
  const other = fakeKeys({ 'g@g.us': { '333@lid': true } });
  assert.equal(await forgetAskers({ keys: other, group: 'g@g.us', participants: ['111@lid'] }), 0);
  assert.equal(other.sets.length, 0);
  const failing = fakeKeys({ 'g@g.us': { '111@lid': true, '333@lid': true } });
  assert.equal(await forgetAskers({ keys: failing, group: 'g@g.us', participants: ['111:3@lid'], lidMapping: { getPNForLID: async () => { throw new Error('x'); } } }), 1);
  assert.deepEqual(failing.memory['g@g.us'], { '333@lid': true });
  assert.equal(await forgetAskers({ keys: failing, group: 'g@g.us', participants: [] }), 0);
  assert.equal(await forgetAskers({ keys: null, group: 'g@g.us', participants: ['111@lid'] }), 0);
});

test('a refusal is told with who asked, and the session marks him for the next post', () => {
  let t = 1_000_000;
  const told = [];
  const c = makeRetryCounter({
    ourMessage: () => ({ ts: t - 1000, group: true }),
    onSkip: (...a) => told.push(a),
    rules: { group: { ...RETRY_RULES.group, perMinute: 1 }, private: { ...RETRY_RULES.private } },
    now: () => t,
  });
  assert.equal(c.get('MSG1:111:4@lid'), undefined);
  assert.equal(c.get('MSG1:222:1@lid'), 99);
  assert.deepEqual(told, [['too_many', 'group', 'MSG1', 'MSG1:222:1@lid']]);
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes("if (group && at > 0) s.refusedAskers.note(group, String(key).slice(at + 1));"));
  assert.ok(session.includes("jid: String(jid || '') });"));
  // The write is started by a module-level timer, never from inside a handled message.
  assert.ok(session.includes('for (const s of sessions.values()) { void flushRefusedAskers(s); void flushOwnKeyGroups(s); void flushHeal(s); }'));
  const worker = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.ok(worker.includes("if (typeof m.forgetRefused === 'boolean') setForgetRefused(m.forgetRefused);"));
});

// 2026-11-22: his own post stood on his own phone as "בהמתנה להודעה זו" again - the
// number's own devices now get the group's key with every post.
test('own devices: forgotten in the group after a post, under the number and under its LID, nobody else', async () => {
  const memory = { 'g1@g.us': { '972587115623:0@s.whatsapp.net': true, '972587115623:7@s.whatsapp.net': true, '4701339:0@lid': true, '972500000001:0@s.whatsapp.net': true, '99887:3@lid': true } };
  const keys = fakeKeys(memory, { tx: true });
  const me = { id: '972587115623:12@s.whatsapp.net', lid: '4701339:12@lid' };
  const dropped = await forgetAskers({ keys, group: 'g1@g.us', participants: [me.id, me.lid], txKey: me.id });
  assert.equal(dropped, 3);
  assert.deepEqual(Object.keys(memory['g1@g.us']).sort(), ['972500000001:0@s.whatsapp.net', '99887:3@lid']);
  assert.deepEqual(keys.txKeys, [me.id]);
});

test('own devices: wired - every group message of ours marks its group, the timer forgets, the ask is written down', () => {
  const src = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(src.includes('noteOwnForNextPost(phone, jid);'));
  assert.ok(src.includes('void flushRefusedAskers(s); void flushOwnKeyGroups(s);'));
  assert.ok(src.includes("participants: [me.id, me.lid].filter(Boolean),"));
  assert.ok(src.includes("'own_device_resend'"));
  assert.ok(src.includes("if (!OWN_KEY_EVERY_POST || !forgetRefused || !retryMode.keepGroupMemory) return;"));
});

// 2026-11-22: a refused asker was never healed (Baileys heals only inside a resend), so
// the same devices asked after every post, for weeks.
test('healer: a refused device is queued once, healed in batches, and not again for half an hour', () => {
  let t = 0;
  const h = makeHealer({ batch: 2, now: () => t });
  h.note('111:0@lid'); h.note('111:0@lid'); h.note('222:3@lid'); h.note('972500000001:5@s.whatsapp.net');
  assert.equal(h.waiting, 3);
  assert.deepEqual(h.take(), ['111:0@lid', '222:3@lid']);
  h.done(2, true);
  assert.deepEqual(h.take(), ['972500000001:5@s.whatsapp.net']);
  h.done(1, false);
  assert.deepEqual(h.take(), []);
  t = 60_000;
  h.note('111:0@lid'); // soon after: the next post has not reached him yet
  assert.equal(h.waiting, 0);
  t = 10 * 60_000;
  h.note('111:0@lid'); // long after he was healed, and still asking
  assert.equal(h.waiting, 0);
  t = 31 * 60_000;
  h.note('111:0@lid');
  assert.equal(h.waiting, 1);
  const s = h.stats();
  assert.deepEqual([s.asked, s.queued, s.healed, s.failed, s.batches, s.again], [7, 4, 2, 1, 2, 2]);
  assert.deepEqual([s.lid, s.pn, s.phone, s.linked], [6, 1, 5, 2]);
});

test('healer: wired - a refusal queues the asker, the timer heals with one question and reads his devices anew', () => {
  const src = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(src.includes('if (at > 0) s.healer.note(String(key).slice(at + 1));'));
  assert.ok(src.includes('void flushHeal(s);'));
  assert.ok(src.includes('sock.assertSessions(batch, true),'));
  assert.ok(src.includes('s.devicesCache?.del?.(userOf(p));'));
  assert.ok(src.includes("if (!HEAL_REFUSED || !forgetRefused || !s.healer?.waiting || s.healing) return;"));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forgetAskers, makeRefusedAskers } from '../retryMode.js';
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
  assert.ok(session.includes('for (const s of sessions.values()) void flushRefusedAskers(s);'));
  const worker = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.ok(worker.includes("if (typeof m.forgetRefused === 'boolean') setForgetRefused(m.forgetRefused);"));
});

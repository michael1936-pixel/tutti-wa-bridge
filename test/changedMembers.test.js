import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forgetEverywhere, makeChangedMembers } from '../retryMode.js';

// 2026-11-24: a member whose phone or devices changed is forgotten in EVERY group's
// memory at once, so the next post in each group carries him the key.

/** A key store of group memories: group -> { deviceJid: true }; counts reads, writes and transactions. */
function store(memories) {
  const mem = JSON.parse(JSON.stringify(memories));
  const calls = { get: 0, set: 0, tx: 0, wrote: [] };
  return {
    mem, calls,
    keys: {
      async get(type, ids) {
        assert.equal(type, 'sender-key-memory');
        calls.get += 1;
        const out = {};
        for (const id of ids) if (mem[id]) out[id] = JSON.parse(JSON.stringify(mem[id]));
        return out;
      },
      async set(data) {
        calls.set += 1;
        for (const [g, v] of Object.entries(data['sender-key-memory'])) { mem[g] = v; calls.wrote.push(g); }
      },
      async transaction(work, key) { calls.tx += 1; assert.equal(key, 'me@s.whatsapp.net'); return work(); },
    },
  };
}

test('a member is forgotten in every group, all his devices, nobody else - one read, one write', async () => {
  const s = store({
    'a@g.us': { '111@lid': true, '111:3@lid': true, '222@lid': true },
    'b@g.us': { '111:5@lid': true, '333@lid': true },
    'c@g.us': { '333@lid': true },
  });
  const r = await forgetEverywhere({ keys: s.keys, groups: ['a@g.us', 'b@g.us', 'c@g.us', 'x@s.whatsapp.net'], participants: ['111@lid'], txKey: 'me@s.whatsapp.net' });
  assert.deepEqual(r, { groups: 2, forgotten: 3 });
  assert.deepEqual(s.mem['a@g.us'], { '222@lid': true });
  assert.deepEqual(s.mem['b@g.us'], { '333@lid': true });
  assert.deepEqual(s.mem['c@g.us'], { '333@lid': true });
  assert.equal(s.calls.get, 1);
  assert.equal(s.calls.set, 1);
  assert.equal(s.calls.tx, 1);
  assert.deepEqual(s.calls.wrote.sort(), ['a@g.us', 'b@g.us'], 'a group with nothing of his is not written');
});

test('his number turned into his LID (and back): the groups keep members under their LID', async () => {
  const s = store({ 'a@g.us': { '555@lid': true, '555:2@lid': true, '666@lid': true } });
  const lidMapping = { getLIDForPN: async (pn) => (pn.startsWith('972501') ? '555@lid' : null), getPNForLID: async () => null };
  const r = await forgetEverywhere({ keys: s.keys, groups: ['a@g.us'], participants: ['972501234567@s.whatsapp.net'], lidMapping, txKey: 'me@s.whatsapp.net' });
  assert.deepEqual(r, { groups: 1, forgotten: 2 });
  assert.deepEqual(s.mem['a@g.us'], { '666@lid': true });
});

test('a lookup that hangs or throws does not stop the forgetting of his own name', async () => {
  const s = store({ 'a@g.us': { '777@lid': true } });
  const lidMapping = { getPNForLID: () => { throw new Error('x'); } };
  const r = await forgetEverywhere({ keys: s.keys, groups: ['a@g.us'], participants: ['777@lid'], lidMapping, txKey: 'me@s.whatsapp.net' });
  assert.deepEqual(r, { groups: 1, forgotten: 1 });
});

test('nothing to do: no groups, no members, nothing remembered - nothing written', async () => {
  const s = store({ 'a@g.us': { '1@lid': true } });
  assert.deepEqual(await forgetEverywhere({ keys: s.keys, groups: [], participants: ['1@lid'] }), { groups: 0, forgotten: 0 });
  assert.deepEqual(await forgetEverywhere({ keys: s.keys, groups: ['a@g.us'], participants: [] }), { groups: 0, forgotten: 0 });
  assert.deepEqual(await forgetEverywhere({ keys: s.keys, groups: ['a@g.us'], participants: ['9@lid'], txKey: 'me@s.whatsapp.net' }), { groups: 0, forgotten: 0 });
  assert.equal(s.calls.set, 0);
});

test('changed members are gathered once each, counted by why and by kind of name', () => {
  const c = makeChangedMembers();
  c.note('111@lid', 'identity');
  c.note('111@lid', 'identity');
  c.note('222:4@lid', 'devices');
  c.note('972501234567@s.whatsapp.net', 'identity');
  c.note('', 'identity');
  assert.equal(c.size, 3);
  const st = c.stats();
  assert.equal(st.identity, 3);
  assert.equal(st.devices, 1);
  assert.equal(st.lid, 3);
  assert.equal(st.pn, 1);
  assert.equal(c.take().length, 3);
  assert.equal(c.size, 0);
  c.done(5, 12);
  assert.equal(c.stats().forgotten, 12);
  assert.equal(c.stats().groups, 5);
});

test('wired: the patch tells of identity and device changes, the bridge forgets them in all groups', () => {
  const patch = readFileSync(new URL('../baileysPatch.js', import.meta.url), 'utf8');
  assert.ok(patch.includes("globalThis.__bridgeRetry?.onIdentityChange?.(from, result?.action)"));
  assert.ok(patch.includes("globalThis.__bridgeRetry?.onDevicesChange?.(tag, decoded.map(d => d.jid), from)"));
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes("noteChangedMember(from, 'identity');"));
  assert.ok(session.includes("if (tag === 'add') for (const j of jids || []) noteChangedMember(j, 'devices');"));
  assert.ok(session.includes('void flushChangedMembers(s);'));
  assert.ok(session.includes('const groups = s.sendGroups?.map ? [...s.sendGroups.map.keys()] : [];'));
  assert.ok(session.includes("const CHANGED_MEMBERS = String(process.env.CHANGED_MEMBERS || 'on').toLowerCase() !== 'off';"));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeOwnTrace } from '../retryMode.js';

// 2026-11-25, Michael «כן, תבנה מעקב»: which of his devices got each post of ours, and how.

const LID = '111222333';
const PN = '972587115623';

test('a post his phone took in time: listed and keyed under his LID, on time', () => {
  let t = 0;
  const tr = makeOwnTrace({ now: () => t });
  tr.post('A', 'g1@g.us', { ownListed: [`${LID}@lid`, `${LID}:7@lid`], ownKeyTo: [`${LID}@lid`], devices: 300 });
  t = 1_500;
  assert.equal(tr.receipt('A', `${LID}@lid`, undefined), true);
  t = 100_000;
  const s = tr.stats();
  assert.equal(s.posts, 1);
  assert.deepEqual(s.by_key, { 'listed_lid|key_lid': { on_time: 1 } });
  assert.deepEqual(s.receipt_types, { 'lid:0|delivery': 1 });
  assert.deepEqual(s.recent[0].listed, ['lid:0', 'lid:7']);
  assert.deepEqual(s.recent[0].receipts, ['lid:0|delivery@1.5s']);
  assert.equal(s.bad.length, 0);
});

test('a receipt from his computer alone is not his phone: other_device_only', () => {
  let t = 0;
  const tr = makeOwnTrace({ now: () => t });
  tr.post('B', 'g1@g.us', { ownListed: [`${PN}@s.whatsapp.net`, `${PN}:3@s.whatsapp.net`], ownKeyTo: [] });
  t = 900;
  tr.receipt('B', `${PN}:3@s.whatsapp.net`);
  t = 95_000;
  const s = tr.stats();
  assert.deepEqual(s.by_key, { 'listed_pn|key_none': { other_device_only: 1 } });
  assert.equal(s.bad[0].outcome, 'other_device_only');
});

test('his phone asked; then took the copy; or said nothing at all', () => {
  let t = 0;
  const tr = makeOwnTrace({ now: () => t });
  tr.post('C', 'g@g.us', { ownListed: [`${LID}@lid`], ownKeyTo: [`${LID}@lid`] });
  tr.post('D', 'g@g.us', { ownListed: [`${LID}@lid`], ownKeyTo: [] });
  tr.post('E', 'g@g.us', { ownListed: [], ownKeyTo: [] });
  t = 2_000;
  tr.receipt('C', `${LID}@lid`, 'retry', 1);
  t = 21_000;
  tr.copy('D', true);
  t = 23_000;
  tr.receipt('D', `${LID}@lid`, 'delivery');
  t = 120_000;
  const s = tr.stats();
  assert.deepEqual(s.by_key, {
    'listed_lid|key_lid': { phone_asked: 1 },
    'listed_lid|key_none': { after_copy: 1 },
    'listed_none|key_none': { silent: 1 },
  });
  assert.deepEqual(s.recent.find((p) => p.id === 'C').receipts, ['lid:0|retry#1@2s']);
  assert.equal(s.recent.find((p) => p.id === 'D').copy, 'ok@21s');
});

test('kept to a bound; a post pushed out is still counted; a receipt for an unknown post only marks the device', () => {
  let t = 0;
  const tr = makeOwnTrace({ now: () => t, max: 10 });
  for (let i = 0; i < 25; i += 1) tr.post(`P${i}`, 'g@g.us', { ownListed: [`${LID}@lid`] });
  assert.equal(tr.receipt('nope', `${LID}:2@lid`, 'read'), false);
  const s = tr.stats();
  assert.ok(s.watching <= 10);
  assert.ok(s.posts >= 15);
  assert.deepEqual(s.devices_seen, { 'lid:2': 1 });
});

test('the bridge wires it: the post hook passes the devices, raw receipts are read, the copy is told, /diag shows it', () => {
  const patch = readFileSync(new URL('../baileysPatch.js', import.meta.url), 'utf8');
  assert.ok(patch.includes('onGroupPost?.(destinationJid, msgId, senderKeyRecipients, devices.length, devices)'));
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8');
  assert.ok(session.includes("sock.ws.on('CB:receipt'"));
  assert.ok(session.includes('ownTraceOf(s).copy(id, true)'));
  assert.ok(session.includes('ownTrace: s.ownTrace ? { ...s.ownTrace.stats(), on: OWN_TRACE } : { on: OWN_TRACE }'));
});

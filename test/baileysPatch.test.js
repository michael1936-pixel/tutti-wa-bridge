import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EDITS, PATCH_MARK, PATCH_VERSION, patchAll, patchSource } from '../baileysPatch.js';

// The installed Baileys, as npm put it there (the tests never write to it).
const dir = new URL('../node_modules/baileys/', import.meta.url);
const installed = (file) => readFileSync(new URL(file, dir), 'utf8');
const stock = (file) => {
  const src = installed(file);
  assert.ok(!src.includes(PATCH_MARK), `${file} is already patched in node_modules — reinstall before testing`);
  return src;
};
const RECV = 'lib/Socket/messages-recv.js';
const SEND = 'lib/Socket/messages-send.js';

test('the patch is for the Baileys that is installed', () => {
  assert.equal(JSON.parse(installed('package.json')).version, PATCH_VERSION);
});

test('every edit finds its place exactly once, and a second run changes nothing', () => {
  const r = patchAll(stock);
  assert.equal(r.state, 'applied', JSON.stringify(r));
  assert.deepEqual(Object.keys(r.files).sort(), [RECV, SEND].sort());
  assert.equal(r.files[RECV].split(PATCH_MARK).length - 1, EDITS[RECV].length);
  assert.equal(r.files[SEND].split(PATCH_MARK).length - 1, EDITS[SEND].length);
  assert.equal(patchAll((f) => r.files[f]).state, 'already');
});

test('a Baileys that reads differently is left untouched — all files or none', () => {
  const other = (f) => (f === SEND ? stock(f).replace("'sending new sender key'", "'sending a new sender key'") : stock(f));
  const r = patchAll(other);
  assert.equal(r.state, 'mismatch');
  assert.deepEqual(r.files, {});
  assert.match(r.edit, /messages-send\.js:group_keys_measured/);
  // one file patched and the other not is not a state the patch leaves
  const half = patchAll((f) => (f === RECV ? patchAll(stock).files[RECV] : stock(f)));
  assert.equal(half.state, 'mismatch');
  assert.equal(half.edit, 'half_patched');
  // an edit that would match twice is refused too
  const twice = patchSource(`${stock(RECV)}\nconst sendToAll = !jidDecode(participant)?.device;`, EDITS[RECV]);
  assert.equal(twice.state, 'mismatch');
  assert.equal(twice.hits, 2);
});

// ---- The patched function itself, run with stand-ins for what it reaches ----------
function sendMessagesAgainOf(src) {
  const start = src.indexOf('const sendMessagesAgain = async (key, ids, retryNode, receiptNode) => {');
  assert.ok(start > 0);
  let depth = 0;
  let end = src.indexOf('{', start);
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}' && --depth === 0) break;
  }
  return src.slice(start, end + 1).replace('const sendMessagesAgain = ', 'return ');
}

function harness(src) {
  const calls = { relay: [], sets: [], asserted: [] };
  const memory = { 'g1@g.us': { '972500000001@s.whatsapp.net': true, '972500000001:7@s.whatsapp.net': true, '972500000002@s.whatsapp.net': true } };
  const deps = {
    messageRetryManager: null,
    getMessage: async () => ({ conversation: 'ride' }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    jidDecode: (jid) => {
      const [left, server] = String(jid).split('@');
      const [user, device] = left.split(':');
      return { user, server, device: device === undefined ? undefined : Number(device) };
    },
    isJidGroup: (jid) => String(jid).endsWith('@g.us'),
    signalRepository: {
      jidToSignalProtocolAddress: (jid) => jid,
      injectE2ESession: async () => {},
      getSessionInfo: async () => null,
      validateSession: async () => ({ exists: true }),
      lidMapping: { getPNForLID: async () => null, getLIDForPN: async () => null },
    },
    extractE2ESessionFromRetryReceipt: () => null,
    getBinaryNodeChildUInt: () => undefined,
    authState: {
      keys: {
        get: async (type, ids) => (type === 'sender-key-memory' ? Object.fromEntries(ids.filter((id) => memory[id]).map((id) => [id, { ...memory[id] }])) : {}),
        set: async (data) => { calls.sets.push(data); for (const [g, v] of Object.entries(data['sender-key-memory'] || {})) { if (v == null) delete memory[g]; else memory[g] = v; } },
      },
    },
    enableAutoSessionRecreation: false,
    assertSessions: async (jids, force) => { calls.asserted.push([jids, force]); },
    willSendMessageAgain: async () => true,
    updateSendMessageAgainCount: async () => {},
    relayMessage: async (jid, msg, opts) => { calls.relay.push({ jid, opts }); },
  };
  const fn = new Function(...Object.keys(deps), sendMessagesAgainOf(src))(...Object.values(deps));
  const retry = (participant, group = 'g1@g.us') => fn({ remoteJid: group, participant, fromMe: true, id: 'M1' }, ['M1'], { attrs: { count: '1' } }, { attrs: {} });
  return { calls, memory, retry };
}

const patchedRecv = () => patchAll(stock).files[RECV];
const PHONE = '972500000001@s.whatsapp.net';
const LINKED = '972500000001:7@s.whatsapp.net';

test('with no switch on, the patched Baileys answers exactly as stock', async () => {
  delete globalThis.__bridgeRetry;
  for (const src of [stock(RECV), patchedRecv()]) {
    const h = harness(src);
    await h.retry(PHONE);
    assert.equal(h.memory['g1@g.us'], undefined, 'the whole group forgotten');
    assert.deepEqual(h.calls.relay[0].opts, { messageId: 'M1', useUserDevicesCache: false }, 'sent again to all, device lists read fresh');
    const h2 = harness(src);
    await h2.retry(LINKED);
    assert.deepEqual(h2.calls.relay[0].opts, { messageId: 'M1', participant: { jid: LINKED, count: 1 } });
  }
});

test('keepGroupMemory: only the one who asked is forgotten; a resend to all keeps the device cache', async () => {
  const { forgetAsker } = await import('../retryMode.js');
  globalThis.__bridgeRetry = { keepGroupMemory: true, forgetAsker };
  try {
    const h = harness(patchedRecv());
    await h.retry(PHONE);
    assert.deepEqual(h.memory['g1@g.us'], { '972500000002@s.whatsapp.net': true }, 'the other member still holds the key');
    assert.deepEqual(h.calls.relay[0].opts, { messageId: 'M1', useUserDevicesCache: true });
    assert.ok(!h.calls.sets.some((d) => d['sender-key-memory']?.['g1@g.us'] === null), 'no wipe of the group');
    // a private chat is not a group: stock
    const h3 = harness(patchedRecv());
    await h3.retry(undefined, PHONE);
    assert.deepEqual(h3.calls.relay[0].opts, { messageId: 'M1', useUserDevicesCache: false });
  } finally {
    delete globalThis.__bridgeRetry;
  }
});

test('a hook that fails falls back to the stock wipe — never to nothing', async () => {
  globalThis.__bridgeRetry = { keepGroupMemory: true, forgetAsker: async () => { throw new Error('boom'); } };
  try {
    const h = harness(patchedRecv());
    await h.retry(PHONE);
    assert.equal(h.memory['g1@g.us'], undefined);
  } finally {
    delete globalThis.__bridgeRetry;
  }
});

test('phonesToParticipant: a phone that asks for a group post gets it alone', async () => {
  const { forgetAsker } = await import('../retryMode.js');
  globalThis.__bridgeRetry = { keepGroupMemory: true, phonesToParticipant: true, forgetAsker };
  try {
    const h = harness(patchedRecv());
    await h.retry(PHONE);
    assert.deepEqual(h.calls.relay[0].opts, { messageId: 'M1', participant: { jid: PHONE, count: 1 } });
    // a private chat's phone retry stays a resend to all his devices (stock)
    const h2 = harness(patchedRecv());
    await h2.retry(undefined, PHONE);
    assert.deepEqual(h2.calls.relay[0].opts, { messageId: 'M1', useUserDevicesCache: false });
  } finally {
    delete globalThis.__bridgeRetry;
  }
});

test('send side: the participants node is left out of a retry only under referenceStanza', () => {
  const src = patchAll(stock).files[SEND];
  assert.ok(src.includes('if (participants.length && !(isRetryResend && globalThis.__bridgeRetry?.referenceStanza)) {'));
  assert.ok(src.includes('globalThis.__bridgeRetry?.onGroupKeys?.(destinationJid, senderKeyRecipients.length, devices.length)'));
});

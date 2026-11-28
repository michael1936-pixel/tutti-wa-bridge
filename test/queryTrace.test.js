import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kindOfQuery, kindsLine, makeQueryTrace } from '../queryTrace.js';
import { EDITS, PATCH_MARK, QUERY_EDITS, QUERY_MARK, patchSource } from '../baileysPatch.js';

// 2026-11-28, Michael «כן, תבנה מעקב»: 053-375-3887 was restarted 19 times in a week for ten
// unanswered questions in a minute, while it kept hearing its groups. Which questions?

const WA = 's.whatsapp.net';
const usync = (context, mode, asks, users) => ({
  tag: 'iq', attrs: { to: WA, type: 'get', xmlns: 'usync' },
  content: [{
    tag: 'usync', attrs: { context, mode, sid: 'x', last: 'true', index: '0' },
    content: [
      { tag: 'query', attrs: {}, content: asks.map((t) => ({ tag: t, attrs: {} })) },
      { tag: 'list', attrs: {}, content: Array.from({ length: users }, (_, i) => ({ tag: 'user', attrs: { jid: `${i}@s.whatsapp.net` } })) },
    ],
  }],
});

test('a question is named by what it asks and of whom', () => {
  assert.equal(kindOfQuery(usync('message', 'query', ['devices'], 3)), 'usync:get:usync/message/query[devices]x2-5');
  assert.equal(kindOfQuery(usync('background', 'query', ['lid'], 1)), 'usync:get:usync/background/query[lid]');
  assert.equal(kindOfQuery(usync('interactive', 'query', ['contact', 'lid'], 40)), 'usync:get:usync/interactive/query[contact+lid]x21+');
  assert.equal(kindOfQuery({ tag: 'iq', attrs: { to: WA, type: 'get', xmlns: 'encrypt' }, content: [{ tag: 'key', attrs: {}, content: [{ tag: 'user', attrs: {} }, { tag: 'user', attrs: {} }] }] }), 'encrypt:get:keyx2-5');
  assert.equal(kindOfQuery({ tag: 'iq', attrs: { to: WA, type: 'get', xmlns: 'encrypt' }, content: [{ tag: 'digest', attrs: {} }] }), 'encrypt:get:digest');
  assert.equal(kindOfQuery({ tag: 'iq', attrs: { to: '1203@g.us', type: 'get', xmlns: 'w:g2' }, content: [{ tag: 'query', attrs: { request: 'interactive' } }] }), 'w:g2:get:query:group');
  assert.equal(kindOfQuery({ tag: 'iq', attrs: { to: WA, type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] }), 'w:p:get:ping');
  assert.equal(kindOfQuery({ tag: 'iq', attrs: { to: '97250@s.whatsapp.net', type: 'get', xmlns: 'w:profile:picture' }, content: [{ tag: 'picture', attrs: {} }] }), 'w:profile:picture:get:picture:user');
});

test('nothing breaks on a node with no name, no children, or nothing at all', () => {
  assert.equal(kindOfQuery(null), '?');
  assert.equal(kindOfQuery({ tag: 'iq', attrs: {} }), 'iq');
  assert.equal(kindOfQuery({ tag: 'iq', attrs: { type: 'set', xmlns: 'privacy' }, content: 'text' }), 'privacy:set');
});

test('a timeout is given the name of what was asked; an answered question is not counted', () => {
  let t = 1_000;
  const tr = makeQueryTrace({ now: () => t });
  tr.sent('a.1', usync('message', 'query', ['devices'], 3));
  tr.sent('a.2', { tag: 'iq', attrs: { to: WA, type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] });
  tr.sent('a.3', usync('message', 'query', ['devices'], 3));
  t += 15_000;
  assert.equal(tr.timedOut('a.1'), 'usync:get:usync/message/query[devices]x2-5');
  assert.equal(tr.timedOut('a.3'), 'usync:get:usync/message/query[devices]x2-5');
  const s = tr.stats();
  assert.equal(s.asked, 3);
  assert.equal(s.timed_out, 2);
  assert.deepEqual(s.timeouts, { 'usync:get:usync/message/query[devices]x2-5': 2 });
  assert.equal(s.sent['w:p:get:ping'], 1);
  assert.equal(s.last.length, 2);
  assert.equal(s.last[0].waitedMs, 15_000);
});

test('an id that never left through us is "unknown" — and still counted', () => {
  const tr = makeQueryTrace({ now: () => 5 });
  assert.equal(tr.timedOut('zz'), 'unknown');
  assert.equal(tr.timedOut(undefined), 'unknown');
  assert.equal(tr.stats().timeouts.unknown, 2);
});

test('the kinds of the last minute — what a restart carries; a spared LID timeout is not among them', () => {
  let t = 0;
  const tr = makeQueryTrace({ now: () => t });
  for (let i = 0; i < 7; i++) tr.sent(`u${i}`, usync('message', 'query', ['devices'], 3));
  for (let i = 0; i < 3; i++) tr.sent(`k${i}`, { tag: 'iq', attrs: { to: WA, type: 'get', xmlns: 'encrypt' }, content: [{ tag: 'key', attrs: {}, content: [{ tag: 'user', attrs: {} }] }] });
  tr.sent('old', usync('background', 'query', ['lid'], 1));
  tr.sent('lid', usync('background', 'query', ['lid'], 1));
  t = 10_000;
  tr.timedOut('old');
  t = 100_000;
  for (let i = 0; i < 7; i++) tr.timedOut(`u${i}`);
  for (let i = 0; i < 3; i++) tr.timedOut(`k${i}`);
  tr.timedOut('lid', { spared: true });
  const kinds = tr.recentKinds(60_000);
  assert.deepEqual(kinds, { 'usync:get:usync/message/query[devices]x2-5': 7, 'encrypt:get:key': 3 });
  assert.equal(kindsLine(kinds), 'usync:get:usync/message/query[devices]x2-5×7, encrypt:get:key×3');
  assert.equal(tr.stats().spared, 1);
  assert.equal(kindsLine({}), '');
});

test('the memory of open questions stays small', () => {
  let t = 0;
  const tr = makeQueryTrace({ max: 100, keepMs: 1_000, now: () => t });
  for (let i = 0; i < 5_000; i++) { t += 10; tr.sent(`q${i}`, { tag: 'iq', attrs: { xmlns: 'w:p', type: 'get' }, content: [{ tag: 'ping', attrs: {} }] }); }
  assert.ok(tr.stats().open <= 100, `open ${tr.stats().open}`);
  assert.equal(tr.stats().asked, 5_000);
});

// ---- the one line in Baileys ---------------------------------------------------------------
const STOCK = [
  '    const query = async (node, timeoutMs) => {',
  '        if (!node.attrs.id) {',
  '            node.attrs.id = generateMessageTag();',
  '        }',
  '        const msgId = node.attrs.id;',
  '        const result = await promiseTimeout(timeoutMs, async (resolve, reject) => {',
].join('\n');

test('the patch names the question as it leaves, once, and is a patch of its own', () => {
  const r = patchSource(STOCK, QUERY_EDITS['lib/Socket/socket.js'], QUERY_MARK);
  assert.equal(r.state, 'applied');
  assert.match(r.out, /const msgId = node\.attrs\.id;\n\s+try \{ globalThis\.__bridgeQuery\?\.sent\?\.\(msgId, node\); \} catch \(_\) \{ \/\* bridge-patch:query-trace \*\/ \}/);
  assert.equal(patchSource(r.out, QUERY_EDITS['lib/Socket/socket.js'], QUERY_MARK).state, 'already');
  // Not the retry patch's file, not its mark: a miss here leaves the retry patch as it is.
  assert.ok(!Object.keys(EDITS).includes('lib/Socket/socket.js'));
  assert.notEqual(QUERY_MARK, PATCH_MARK);
  assert.ok(!r.out.includes(PATCH_MARK));
});

test('a Baileys whose line moved: nothing is written, and it says so', () => {
  const r = patchSource('const messageId = node.attrs.id;', QUERY_EDITS['lib/Socket/socket.js'], QUERY_MARK);
  assert.equal(r.state, 'mismatch');
  assert.equal(r.edit, 'query_named_as_it_leaves');
});

test('the wiring: named when it leaves, counted when it times out, carried by the restart, shown in /diag', () => {
  const session = readFileSync(new URL('../session.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(session.includes('sent: (msgId, node) => { for (const s of sessions.values()) queryTraceOf(s).sent(msgId, node); },'));
  assert.ok(session.includes("if (QUERY_TIMEOUT.test(msg)) queryTraceOf(s).timedOut(a.find((x) => x && typeof x === 'object')?.msgId, { spared: lidOnly });"));
  assert.ok(session.includes("emitEvent('session_stuck_restart', { phone: s.phone, timeouts: s.health.timeouts.length, kinds: kindsLine(kinds), hears });"));
  assert.ok(session.includes('queries: s.queryTrace ? s.queryTrace.stats() : null,'));
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(server.includes('QUERY_PATCH = applyQueryTracePatch(__dirname);'));
  assert.ok(server.includes('baileys_query_trace: QUERY_PATCH.state,'));
  // The restart rule itself is as it was: this only counts.
  assert.ok(session.includes('const STUCK_SOCKET = { windowMs: 60_000, timeouts: 2, minGapMs: 5 * 60_000, quietMs: 45_000, floodTimeouts: 10 };'));
});

// npm test (node --test test/*.test.js)  — the number's routes (session.js) answer as the old
// HTTP handlers did when no socket exists; nothing here talks to WhatsApp.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
process.env.AUTH_DIR = dir;
process.env.LOG_LEVEL = 'silent';
const session = await import('../session.js');

test('routes without a session answer 409 not_started, as before', async () => {
  const out = await session.runRoute('POST /send', { body: { session: '972500000001', jid: 'a@s.whatsapp.net', text: 'hi' } });
  assert.deepEqual(out, { code: 409, body: { error: 'session_missing', status: 'not_started' } });
  const g = await session.runRoute('GET /groups', { query: { session: '972500000001' } });
  assert.deepEqual(g, { code: 409, body: { error: 'session_missing', status: 'not_started' } });
});

test('missing fields answer the same 400', async () => {
  const out = await session.runRoute('POST /edit', { body: { session: '972500000001', jid: 'x' } });
  assert.deepEqual(out, { code: 400, body: { error: 'jid, id, text, session required' } });
});

test('logout of an unknown number wipes nothing that is not there and says ok', async () => {
  fs.mkdirSync(path.join(dir, 'auth', '972500000002'), { recursive: true });
  const out = await session.runRoute('DELETE /session/:phone', { params: { phone: '972500000002' } });
  assert.deepEqual(out, { code: 200, body: { ok: true, phone: '972500000002' } });
  assert.equal(fs.existsSync(path.join(dir, 'auth', '972500000002')), false);
});

test('unknown route is 404, snapshot of an unknown number is null', async () => {
  assert.equal((await session.runRoute('GET /nope')).code, 404);
  assert.equal(session.snapshotOf('972500000003'), null);
  assert.equal(session.restartSocket('972500000003', 'test'), false);
});

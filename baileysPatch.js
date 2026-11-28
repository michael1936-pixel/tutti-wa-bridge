// =============================================================================
// How Baileys 7.0.0-rc13 answers a member's device that asks for a GROUP post
// again ("retry receipt") — the root of the jam of 12.11.2026 16:29 (and of the
// number's daily restarts).
//
// Read from the logs of that hour (058-711-5623, the number that publishes to
// ~100 groups and hears ~97% of the feed):
//   * every group post took 4–8 s to send, and the number's event loop stood
//     still 2–5 s at a time (worker_event_loop_lag, 18 times in 8 minutes);
//   * 15–25 "send again" requests a minute; ~75% of our resends were rejected
//     by WhatsApp ("smax-invalid 479");
//   * CPU: one core full (the service's limit is 24 — no bigger server helps a
//     single thread); 82 queries timed out, the number was restarted, and
//     WhatsApp's backlog was then worked through one retry at a time — 20
//     minutes without a group message.
//
// Why — two lines of Baileys:
//   1. messages-recv.js, sendMessagesAgain: for ANY retry of a group post it
//      forgets who holds the group's key
//      (`'sender-key-memory': { [group]: null }`), so the NEXT post to that
//      group encrypts the key again for EVERY device in it (~1,500 pairwise
//      encryptions, ~2 s of one thread). With a few retries a minute over 100
//      groups, every post is a full re-keying.
//   2. same function: a retry that comes from a phone (device 0) is answered
//      by sending the post again to the WHOLE group, device lists read fresh
//      from WhatsApp.
//
// What the patch does (each part behind a switch of globalThis.__bridgeRetry,
// set by session.js — with no switch on, Baileys behaves exactly as stock):
//   keepGroupMemory     only the device that asked is forgotten (hook
//                       forgetAsker), so the next post carries the key to it
//                       alone; a resend to all keeps the device-list cache.
//   referenceStanza     the resend to one device goes out as the reference
//                       clients send it: one <enc count> and no <participants>.
//   phonesToParticipant a phone's retry of a group post is answered to that
//                       phone alone, not to the whole group.
//   + onGroupKeys       tells session.js how many devices a group post carried
//                       the key to (measurement only).
//
// The edits are exact-match, all or nothing, and only for the version they
// were read against; anything else leaves Baileys untouched and says so.
// =============================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const PATCH_VERSION = '7.0.0-rc13';
export const PATCH_MARK = 'bridge-patch:group-retry';

const RECV = 'lib/Socket/messages-recv.js';
const SEND = 'lib/Socket/messages-send.js';
const RETRY = 'lib/Utils/message-retry-manager.js';

/** file → edits; `find` must match exactly once. */
export const EDITS = {
  [RECV]: [
    {
      name: 'phone_retry_to_the_phone_alone',
      find: /const sendToAll = !jidDecode\(participant\)\?\.device;/g,
      put: `const sendToAll = !jidDecode(participant)?.device && !(isJidGroup(remoteJid) && globalThis.__bridgeRetry?.phonesToParticipant && !globalThis.__bridgeRetry?.isOwn?.(participant)); /* ${PATCH_MARK} */`,
    },
    {
      name: 'only_the_asker_is_forgotten',
      find: /if \(isJidGroup\(remoteJid\)\) \{\s*await authState\.keys\.set\(\{ 'sender-key-memory': \{ \[remoteJid\]: null \} \}\);\s*\}/g,
      put: [
        'if (isJidGroup(remoteJid)) {',
        `            /* ${PATCH_MARK} */`,
        '            let bridgeHandled = false;',
        '            try {',
        '                bridgeHandled = !!(await globalThis.__bridgeRetry?.forgetAsker?.({ keys: authState.keys, group: remoteJid, participant, lidMapping: signalRepository.lidMapping }));',
        '            }',
        '            catch (_) {',
        '                bridgeHandled = false;',
        '            }',
        '            if (!bridgeHandled) {',
        "                await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } });",
        '            }',
        '        }',
      ].join('\n'),
    },
    {
      name: 'phone_request_without_the_second_wait',
      find: /await delay\(2000\);/g,
      put: `await delay(globalThis.__bridgeRetry?.placeholderDelayMs ?? 2000); /* ${PATCH_MARK} */`,
    },
    {
      name: 'resend_to_all_keeps_device_cache',
      find: /if \(sendToAll\) \{\s*msgRelayOpts\.useUserDevicesCache = false;\s*\}/g,
      put: [
        'if (sendToAll) {',
        `                    /* ${PATCH_MARK} */`,
        '                    msgRelayOpts.useUserDevicesCache = !!(isJidGroup(remoteJid) && globalThis.__bridgeRetry?.keepGroupMemory);',
        '                }',
      ].join('\n'),
    },
    // 15.11.2026, the feed's tail (messages 10–90 s late, minutes at a time): a
    // message that does not decrypt is asked for again inside the ONE lock every
    // incoming message of the number passes through, with a 250 ms wait, and then
    // answered with an error (nack 500) — so it comes again. After five times
    // Baileys ERASES its count (markRetryFailed) and starts over: two bots' posts
    // went round every 0.6 s, 200–800 times each, and every other message waited
    // behind them. The bridge counts by itself (retryMode.js makeUndecryptable):
    // from the sixth failure the message is acknowledged plainly and left to the
    // number's own phone — no request, no wait, no error.
    {
      name: 'undecryptable_is_not_asked_forever',
      find: /const encNode = getBinaryNodeChild\(node, 'enc'\);\s*await sendRetryRequest\(node, !encNode\);/g,
      put: [
        `/* ${PATCH_MARK} */`,
        '                                if (globalThis.__bridgeRetry?.undecryptable?.(msg.key?.id)) {',
        '                                    acked = true;',
        '                                    await sendMessageAck(node);',
        '                                    return;',
        '                                }',
        "                                const encNode = getBinaryNodeChild(node, 'enc');",
        '                                await sendRetryRequest(node, !encNode);',
      ].join('\n'),
    },
    // 2026-11-24: a member's identity changed (a reinstall, a new phone) or his
    // devices changed - the bridge forgets him in every group's memory, so the next
    // post in each carries him the key (session.js flushChangedMembers). Baileys
    // itself only renews his private session / his device list.
    {
      name: 'member_identity_changed',
      find: /if \(result\.action === 'no_identity_node'\) \{/g,
      put: [
        `try { globalThis.__bridgeRetry?.onIdentityChange?.(from, result?.action); } catch (_) { /* ${PATCH_MARK} */ }`,
        "            if (result.action === 'no_identity_node') {",
      ].join('\n'),
    },
    {
      name: 'member_devices_changed',
      find: /if \(!decoded\.length\)\s*return;\s*await devicesMutex\.mutex\(async \(\) => \{/g,
      put: [
        'if (!decoded.length)',
        '            return;',
        `        try { globalThis.__bridgeRetry?.onDevicesChange?.(tag, decoded.map(d => d.jid), from); } catch (_) { /* ${PATCH_MARK} */ }`,
        '        await devicesMutex.mutex(async () => {',
      ].join('\n'),
    },
  ],
  // A message that does not decrypt is asked again from its sender, and — when
  // the sender's copy has not come — from the number's own phone, which holds
  // it readable. Baileys waits 3 s before it turns to the phone and 2 s more
  // inside the request: 5 s on every message of a sender whose resends never
  // arrive (14.11.2026: seven senders, bots, ALL of their posts exactly 5 s
  // late — the "6-second" tail of the feed). Both waits are the bridge's to set.
  [RETRY]: [
    {
      name: 'phone_asked_sooner',
      find: /schedulePhoneRequest\(messageId, callback, delay = PHONE_REQUEST_DELAY\) \{/g,
      put: `schedulePhoneRequest(messageId, callback, delay = (globalThis.__bridgeRetry?.phoneDelayMs ?? PHONE_REQUEST_DELAY)) { /* ${PATCH_MARK} */`,
    },
  ],
  [SEND]: [
    {
      name: 'reference_retry_stanza',
      find: /if \(participants\.length\) \{\s*if \(additionalAttributes\?\.\['category'\] === 'peer'\) \{/g,
      put: [
        `if (participants.length && !(isRetryResend && globalThis.__bridgeRetry?.referenceStanza)) { /* ${PATCH_MARK} */`,
        "                if (additionalAttributes?.['category'] === 'peer') {",
      ].join('\n'),
    },
    {
      name: 'group_keys_measured',
      find: /logger\.debug\(\{ senderKeyJids: senderKeyRecipients \}, 'sending new sender key'\);/g,
      put: [
        "logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending new sender key');",
        `                    try { globalThis.__bridgeRetry?.onGroupKeys?.(destinationJid, senderKeyRecipients.length, devices.length); } catch (_) { /* ${PATCH_MARK} */ }`,
      ].join('\n'),
    },
    // 2026-11-24 (the askers' probe): every group post says which devices it carried
    // the group's key to - also none - so an ask for that post can be told apart:
    // "he got the key in it and still could not read it" from "we thought he held it".
    {
      name: 'group_post_key_recipients',
      find: /await authState\.keys\.set\(\{ 'sender-key-memory': \{ \[jid\]: senderKeyMap \} \}\);/g,
      put: [
        "await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });",
        `                try { globalThis.__bridgeRetry?.onGroupPost?.(destinationJid, msgId, senderKeyRecipients, devices.length, devices); } catch (_) { /* ${PATCH_MARK} */ }`,
      ].join('\n'),
    },
  ],
};

/**
 * One file's source with its edits. Pure.
 * → { state: 'applied' | 'already' | 'mismatch', out, edit?, hits? }
 */
export function patchSource(src, edits, mark = PATCH_MARK) {
  if (src.includes(mark)) return { state: 'already', out: src };
  let out = src;
  for (const e of edits) {
    const hits = out.match(e.find);
    if (!hits || hits.length !== 1) return { state: 'mismatch', out: src, edit: e.name, hits: hits ? hits.length : 0 };
    out = out.replace(e.find, () => e.put);
  }
  return { state: 'applied', out };
}

/**
 * All files or none. `read(file)` → source. Pure.
 * → { state: 'applied' | 'already' | 'mismatch', files: { file: out }, edit? }
 */
export function patchAll(read, edits = EDITS) {
  const files = {};
  let already = 0;
  for (const [file, list] of Object.entries(edits)) {
    const r = patchSource(read(file), list);
    if (r.state === 'mismatch') return { state: 'mismatch', files: {}, edit: `${file}:${r.edit}`, hits: r.hits };
    if (r.state === 'already') already += 1;
    else files[file] = r.out;
  }
  const total = Object.keys(edits).length;
  if (already === total) return { state: 'already', files: {} };
  // Half patched (one file marked, the other not) is not a state we wrote: leave it.
  if (already > 0) return { state: 'mismatch', files: {}, edit: 'half_patched' };
  return { state: 'applied', files };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- The query trace (2026-11-28, queryTrace.js) -----------------------------------
// One line in Baileys' `query`: every question to WhatsApp is named as it leaves, so a
// "timed out waiting for message" can be told what it was. A patch of its OWN — its own
// file, its own mark: if this line ever stops matching, the retry patch above is not
// touched and the bridge runs exactly as before, only without the names.
export const QUERY_MARK = 'bridge-patch:query-trace';
const SOCKET = 'lib/Socket/socket.js';
export const QUERY_EDITS = {
  [SOCKET]: [
    {
      name: 'query_named_as_it_leaves',
      find: /const msgId = node\.attrs\.id;/g,
      put: [
        'const msgId = node.attrs.id;',
        `        try { globalThis.__bridgeQuery?.sent?.(msgId, node); } catch (_) { /* ${QUERY_MARK} */ }`,
      ].join('\n'),
    },
  ],
};

/** The query trace's patch of the installed Baileys. Never throws; never touches the retry patch. */
export function applyQueryTracePatch(root = HERE) {
  try {
    const dir = path.join(root, 'node_modules', 'baileys');
    const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    if (version !== PATCH_VERSION) return { state: 'version', version };
    const target = path.join(dir, SOCKET);
    const r = patchSource(fs.readFileSync(target, 'utf8'), QUERY_EDITS[SOCKET], QUERY_MARK);
    if (r.state !== 'applied') return { state: r.state, ...(r.edit ? { edit: r.edit, hits: r.hits } : {}) };
    const tmp = `${target}.bridge-query.tmp`;
    fs.writeFileSync(tmp, r.out, 'utf8');
    fs.renameSync(tmp, target);
    return { state: 'applied' };
  } catch (err) {
    return { state: 'error', error: err?.message || String(err) };
  }
}

/** Is the installed Baileys patched? (read by session.js at load) */
export function baileysPatched(root = HERE) {
  try {
    const dir = path.join(root, 'node_modules', 'baileys');
    return Object.keys(EDITS).every((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes(PATCH_MARK));
  } catch (_) {
    return false;
  }
}

/**
 * Patch the installed Baileys in place (server.js, before any number's process
 * loads it). Never throws.
 * → { state: 'applied' | 'already' | 'mismatch' | 'version' | 'error', ... }
 */
export function applyBaileysPatch(root = HERE) {
  try {
    const dir = path.join(root, 'node_modules', 'baileys');
    const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    if (version !== PATCH_VERSION) return { state: 'version', version };
    const r = patchAll((file) => fs.readFileSync(path.join(dir, file), 'utf8'));
    if (r.state !== 'applied') return { state: r.state, ...(r.edit ? { edit: r.edit, hits: r.hits } : {}) };
    // Both files are written to the side first, then put in place.
    const staged = [];
    for (const [file, out] of Object.entries(r.files)) {
      const target = path.join(dir, file);
      const tmp = `${target}.bridge-patch.tmp`;
      fs.writeFileSync(tmp, out, 'utf8');
      staged.push([tmp, target]);
    }
    for (const [tmp, target] of staged) fs.renameSync(tmp, target);
    return { state: 'applied', files: Object.keys(r.files) };
  } catch (err) {
    return { state: 'error', error: err?.message || String(err) };
  }
}

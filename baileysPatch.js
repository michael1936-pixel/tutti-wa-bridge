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

/** file → edits; `find` must match exactly once. */
export const EDITS = {
  [RECV]: [
    {
      name: 'phone_retry_to_the_phone_alone',
      find: /const sendToAll = !jidDecode\(participant\)\?\.device;/g,
      put: `const sendToAll = !jidDecode(participant)?.device && !(isJidGroup(remoteJid) && globalThis.__bridgeRetry?.phonesToParticipant); /* ${PATCH_MARK} */`,
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
      name: 'resend_to_all_keeps_device_cache',
      find: /if \(sendToAll\) \{\s*msgRelayOpts\.useUserDevicesCache = false;\s*\}/g,
      put: [
        'if (sendToAll) {',
        `                    /* ${PATCH_MARK} */`,
        '                    msgRelayOpts.useUserDevicesCache = !!(isJidGroup(remoteJid) && globalThis.__bridgeRetry?.keepGroupMemory);',
        '                }',
      ].join('\n'),
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
  ],
};

/**
 * One file's source with its edits. Pure.
 * → { state: 'applied' | 'already' | 'mismatch', out, edit?, hits? }
 */
export function patchSource(src, edits) {
  if (src.includes(PATCH_MARK)) return { state: 'already', out: src };
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

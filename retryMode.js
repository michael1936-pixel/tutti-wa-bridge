// =============================================================================
// What session.js gives the retry patch (baileysPatch.js), and two guards that
// keep one number's thread free. All pure — no Baileys, no socket (tests:
// test/retryMode.test.js).
// =============================================================================

import { AsyncResource } from 'node:async_hooks';

// ---- The patch's switches ----------------------------------------------------
// keepGroupMemory on from the first day: it only stops the re-keying of whole
// groups. The other two change what a member's device is sent on a retry —
// they are turned on one at a time, after the numbers of the step before were
// read (retry_stats in the log, /diag).
export const DEFAULT_MODE = Object.freeze({ keepGroupMemory: true, referenceStanza: false, phonesToParticipant: false });
const MODE_WORDS = { keep: 'keepGroupMemory', reference: 'referenceStanza', phones: 'phonesToParticipant' };

/** 'keep,reference' | { reference: true } | { referenceStanza: true } → a full mode. Unknown words are ignored. */
export function parseMode(raw, base = DEFAULT_MODE) {
  const mode = { ...base };
  if (raw == null || raw === '') return mode;
  if (typeof raw === 'string') {
    const words = raw.split(/[\s,]+/).map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (words.includes('stock')) return { keepGroupMemory: false, referenceStanza: false, phonesToParticipant: false };
    for (const key of Object.values(MODE_WORDS)) mode[key] = false;
    for (const w of words) if (MODE_WORDS[w]) mode[MODE_WORDS[w]] = true;
    return mode;
  }
  if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const key = MODE_WORDS[k] || (k in mode ? k : null);
      if (key && typeof v === 'boolean') mode[key] = v;
    }
  }
  return mode;
}

// ---- Jids, without Baileys -----------------------------------------------------
/** '972501234567:5@s.whatsapp.net' → '972501234567' */
export function userOf(jid) {
  return String(jid ?? '').split('@')[0].split(':')[0].split('_')[0];
}
/** The device number of a jid; 0 for a phone ('…@s.whatsapp.net', '…:0@lid'). */
export function deviceOf(jid) {
  const d = Number(String(jid ?? '').split('@')[0].split(':')[1]);
  return Number.isFinite(d) ? d : 0;
}
const isLid = (jid) => /@(hosted\.)?lid$/.test(String(jid ?? ''));

const capped = (promise, ms) => Promise.race([
  Promise.resolve(promise),
  new Promise((resolve) => { const t = setTimeout(() => resolve(null), ms); t.unref?.(); }),
]);

/**
 * The patch's hook: a device asked for a group post again — forget that the
 * USER holds the group's key (all his devices, under his phone number and his
 * LID), nobody else. The next post to the group carries the key to him alone.
 * → true when done (the patch then skips Baileys' wipe of the whole group).
 *
 * `repeats` (a Map kept by the caller): a member who asks a third time within
 * `repeatWindowMs` while nothing of his was found in the memory may be held
 * there under a name we do not know — then the stock wipe is let through
 * (→ false), at most once per group per window, so he is never left without
 * the key for good.
 */
export async function forgetAsker({ keys, group, participant, lidMapping }, { repeats, now = Date.now, repeatWindowMs = 10 * 60_000 } = {}) {
  const user = userOf(participant);
  if (!keys || !group || !user) return false;
  const mem = (await keys.get('sender-key-memory', [group]))?.[group];
  if (!mem || typeof mem !== 'object') return true; // nothing remembered — nothing to forget
  const users = new Set([user]);
  try {
    const alt = await capped(isLid(participant) ? lidMapping?.getPNForLID?.(participant) : lidMapping?.getLIDForPN?.(participant), 1_500);
    if (alt) users.add(userOf(alt));
  } catch (_) { /* his other name is not known — his own is forgotten */ }
  const next = {};
  let changed = false;
  for (const [jid, held] of Object.entries(mem)) {
    if (users.has(userOf(jid))) changed = true;
    else next[jid] = held;
  }
  if (changed) {
    await keys.set({ 'sender-key-memory': { [group]: next } });
    return true;
  }
  if (repeats) {
    const t = now();
    const key = `${group}|${user}`;
    const seen = repeats.get(key);
    const count = seen && t - seen.t < repeatWindowMs ? seen.count + 1 : 1;
    repeats.set(key, { t: seen && t - seen.t < repeatWindowMs ? seen.t : t, count });
    if (repeats.size > 5_000) for (const [k, e] of repeats) if (t - e.t >= repeatWindowMs) repeats.delete(k);
    const wiped = repeats.get(`wipe|${group}`);
    if (count >= 3 && !(wiped && t - wiped.t < repeatWindowMs)) {
      repeats.set(`wipe|${group}`, { t, count: 1 });
      return false;
    }
  }
  return true;
}

// ---- Resends and WhatsApp's rejections, counted by who asked -------------------
/**
 * `resend(key)` — a resend let through for `${msgId}:${participant}`;
 * `rejected(msgId)` — WhatsApp answered 479 to a stanza with that id. A
 * rejection is counted to the latest resend of that message not yet rejected.
 * phone = the member's phone asked, linked = a linked device of his.
 */
export function makeRetryStats({ now = Date.now, keepMs = 2 * 60_000 } = {}) {
  const fresh = () => ({ phone: { resends: 0, rejected: 0 }, linked: { resends: 0, rejected: 0 }, unmatched: 0 });
  let totals = fresh();
  const open = new Map(); // msgId -> [{ t, kind }]
  const sweep = (t) => {
    for (const [id, list] of open) {
      const kept = list.filter((e) => t - e.t <= keepMs);
      if (kept.length) open.set(id, kept); else open.delete(id);
    }
  };
  let sweptAt = 0;
  return {
    resend(key) {
      const k = String(key ?? '');
      const at = k.indexOf(':');
      const id = at < 0 ? k : k.slice(0, at);
      const kind = deviceOf(at < 0 ? '' : k.slice(at + 1)) ? 'linked' : 'phone';
      const t = now();
      totals[kind].resends += 1;
      if (!open.has(id)) open.set(id, []);
      open.get(id).push({ t, kind });
      if (t - sweptAt > 30_000) { sweptAt = t; sweep(t); }
      return kind;
    },
    rejected(id) {
      const t = now();
      const list = (open.get(String(id ?? '')) || []).filter((e) => t - e.t <= keepMs);
      const e = list.pop();
      if (list.length) open.set(String(id), list); else open.delete(String(id));
      if (!e) { totals.unmatched += 1; return null; }
      totals[e.kind].rejected += 1;
      return e.kind;
    },
    totals: () => JSON.parse(JSON.stringify(totals)),
    /** Start counting anew (a switch of the mode); returns what was counted. */
    reset() { const was = totals; totals = fresh(); open.clear(); return was; },
  };
}

// ---- "What is this phone number's LID?" asked once, not per message --------------
// Baileys asks WhatsApp (USync) for the LID of a sender it has no LID for —
// before EVERY message of his, and for every session it loads; an answer of
// "none" is not kept. 058-711-5623 sent such a question about once a second,
// some were never answered (15 s), and two unanswered ones within a minute were
// taken for a stuck socket: the number was restarted 13–26 times a day for it
// (12.11.2026). An unanswered or empty question is now remembered: the same
// number is not asked about again for a while, and nothing waits on WhatsApp
// longer than `timeoutMs`.
export function guardLidLookup(lookup, {
  emptyTtlMs = 30 * 60_000, failTtlMs = 2 * 60_000, timeoutMs = 4_000, max = 50_000, now = Date.now,
  // The number's own memory and counts, kept across its sockets; `onTimeout` is told of a question given up on.
  memory = new Map(), stat = { asked: 0, spared: 0, empty: 0, timedOut: 0, failed: 0 }, onTimeout,
} = {}) {
  const none = memory; // pn jid -> not before
  const guarded = async (jids) => {
    const t = now();
    const list = Array.isArray(jids) ? jids : [];
    const ask = list.filter((j) => !(none.get(j) > t));
    stat.spared += list.length - ask.length;
    if (!ask.length) return [];
    stat.asked += ask.length;
    let result = null;
    let outcome = 'ok';
    let timer;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => lookup(ask)),
        new Promise((resolve) => { timer = setTimeout(() => { outcome = 'timeout'; resolve(null); }, timeoutMs); }),
      ]);
    } catch (_) {
      outcome = 'failed';
      result = null;
    } finally {
      clearTimeout(timer);
    }
    const pairs = Array.isArray(result) ? result : [];
    const got = new Set(pairs.map((p) => p?.pn));
    if (outcome === 'timeout') {
      stat.timedOut += 1;
      try { onTimeout?.(); } catch (_) { /* a note only */ }
    } else if (outcome === 'failed') stat.failed += 1;
    const until = now() + (outcome === 'ok' ? emptyTtlMs : failTtlMs);
    for (const j of ask) {
      if (got.has(j)) continue;
      if (outcome === 'ok') stat.empty += 1;
      none.set(j, until);
    }
    if (none.size > max) {
      const t2 = now();
      for (const [j, u] of none) if (u <= t2) none.delete(j);
      if (none.size > max) { let drop = none.size - Math.floor(max / 2); for (const j of none.keys()) { if (drop-- <= 0) break; none.delete(j); } }
    }
    return pairs;
  };
  guarded.stat = stat;
  guarded.size = () => none.size;
  return guarded;
}

// ---- Many encryptions in a row let the rest of the number breathe ----------------
// A group post to a group whose devices do not hold our key yet encrypts for
// each device — ~1,500 one after the other without a pause held the number's
// loop for 2–5 s: nothing was read from WhatsApp meanwhile (12.11.2026). The
// encryptions go through one line, and every `sliceMs` of work the line steps
// aside for whatever else is waiting (incoming messages, answers to queries).
export function makeBreather({
  sliceMs = 12,
  // A few at a time, in the order they came: one that waits on WhatsApp (a
  // LID question) does not hold the ones behind it.
  lanes = 4,
  now = () => performance.now(),
  pause = () => new Promise((resolve) => setImmediate(resolve)),
} = {}) {
  const waiting = [];
  let busy = 0;
  let sliceStart = now();
  let pauses = 0;
  let pausing = null;
  const next = () => {
    while (busy < lanes && waiting.length) {
      const job = waiting.shift();
      busy += 1;
      (async () => {
        try {
          // One pause serves every lane: the slice starts anew for all of them.
          if (pausing) await pausing;
          else if (now() - sliceStart >= sliceMs) {
            pausing = Promise.resolve(pause()).then(() => { pauses += 1; sliceStart = now(); pausing = null; });
            await pausing;
          }
          job.resolve(await job.work());
        } catch (err) {
          job.reject(err);
        } finally {
          busy -= 1;
          next();
        }
      })();
    }
  };
  // The work keeps the context it was handed over in: Baileys' key store knows
  // "inside a transaction" by it (AsyncLocalStorage), and a job started from
  // another job's lane would otherwise write into that job's transaction.
  const run = (work) => new Promise((resolve, reject) => {
    waiting.push({ work: AsyncResource.bind(work), resolve, reject });
    next();
  });
  run.pauses = () => pauses;
  return run;
}

/**
 * A big write to the key files goes in slices with a breath between them. One
 * group post that carried the key to 1,500 devices ends in 1,500 session files
 * written at once — each turned to text in one unbroken run. The key store's
 * cache above already holds all of them; only the files follow in slices.
 */
export async function setInSlices(keys, data, { slice = 40, pause = () => new Promise((resolve) => setImmediate(resolve)) } = {}) {
  let total = 0;
  for (const items of Object.values(data || {})) total += Object.keys(items || {}).length;
  if (total <= slice) return keys.set(data);
  let part = {};
  let count = 0;
  for (const [category, items] of Object.entries(data)) {
    for (const [id, value] of Object.entries(items || {})) {
      (part[category] = part[category] || {})[id] = value;
      count += 1;
      if (count >= slice) {
        await keys.set(part);
        await pause();
        part = {};
        count = 0;
      }
    }
  }
  if (count) await keys.set(part);
  return undefined;
}

/** A signal repository whose pairwise work goes through the breather. */
export function breathingRepository(repo, breathe) {
  for (const name of ['encryptMessage', 'injectE2ESession']) {
    const stock = repo?.[name];
    if (typeof stock !== 'function') continue;
    repo[name] = (...args) => breathe(() => stock.apply(repo, args));
  }
  return repo;
}

// ---- A send waits for the number's socket ------------------------------------------
/**
 * Resolves true as soon as `ready()` holds, false after `waitMs`. A group post
 * that meets a reconnecting number (a few seconds) goes out the moment the
 * socket is up — it is not refused and tried again later by the server.
 */
export async function waitUntil(ready, { waitMs = 20_000, stepMs = 150, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const end = now() + waitMs;
  for (;;) {
    if (ready()) return true;
    if (now() >= end) return false;
    await sleep(stepMs);
  }
}

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

// ---- Members REFUSED a resend still get the key with the next post -------------
// 2026-11-15, "בהמתנה להודעה זו" on members' phones, post after post: a resend
// refused by the limit (retryGuard.js — too many a minute, too old) ended in
// Baileys before anything was forgotten, so the group's memory went on saying
// the member holds the key. He did not: every later post failed on his phone
// too, he asked again, and was refused again — 12,000 refusals in 18 minutes
// on 17 posts. A refused asker is forgotten like an answered one: he misses
// the post he asked for, and the next post carries the key to him.

/** The refused askers gathered between two writes: group -> the devices that asked. */
export function makeRefusedAskers({ maxPerGroup = 3_000 } = {}) {
  let groups = new Map();
  return {
    note(group, participant) {
      if (!group || !participant) return;
      let set = groups.get(group);
      if (!set) groups.set(group, (set = new Set()));
      if (set.size < maxPerGroup) set.add(String(participant));
    },
    /** What was gathered; the gathering starts anew. */
    take() {
      const out = groups;
      groups = new Map();
      return out;
    },
    get size() { return groups.size; },
  };
}

/**
 * Forget that these askers hold the group's key — all the devices of each,
 * nobody else. One read and one write of the group's memory, inside the key
 * store's transaction of the number (`txKey`: the one a post is sent under), so
 * a post going out at that moment neither undoes it nor is changed half-way.
 * WhatsApp is asked nothing: an asker's LID is turned into his number only
 * from what the store already knows. -> how many remembered devices were forgotten.
 */
export async function forgetAskers({ keys, group, participants, lidMapping, txKey }) {
  if (!keys || !group || !participants?.length) return 0;
  const users = new Set();
  await Promise.all(participants.map(async (p) => {
    const user = userOf(p);
    if (!user) return;
    users.add(user);
    if (!isLid(p)) return;
    try {
      const alt = await capped(lidMapping?.getPNForLID?.(p), 1_500);
      if (alt) users.add(userOf(alt));
    } catch (_) { /* his number is not known — his LID is forgotten */ }
  }));
  if (!users.size) return 0;
  const work = async () => {
    const mem = (await keys.get('sender-key-memory', [group]))?.[group];
    if (!mem || typeof mem !== 'object') return 0;
    const next = {};
    let dropped = 0;
    for (const [jid, held] of Object.entries(mem)) {
      if (users.has(userOf(jid))) dropped += 1;
      else next[jid] = held;
    }
    if (dropped) await keys.set({ 'sender-key-memory': { [group]: next } });
    return dropped;
  };
  return typeof keys.transaction === 'function' && txKey ? keys.transaction(work, txKey) : work();
}

// ---- A member REFUSED a resend is healed, so he stops asking --------------------
// 2026-11-22 ("בהמתנה להודעה זו" on members' phones, Michael: «אסור אסור שזה
// יקרה»): ~57 devices asked after every post of ours, for weeks, and ~50 of them
// were refused by the limit. Baileys heals an asker only inside the resend it
// makes (a fresh session from his retry receipt / assertSessions(force),
// messages-recv.js sendMessagesAgain) - a refused asker got none of it: he was
// forgotten in the group's memory, the next post carried him the key over the
// SAME broken session (or not at all, his device missing from the cached device
// list), and he asked again on every post, for ever.
// Now a refused asker is also (a) given a fresh session, many askers in one
// question to WhatsApp, and (b) dropped from the cached device list, so the next
// post reads his devices anew. One device is healed once in `everyMs`.
// `again` counts a device refused again long after it was healed: if that stays
// high, the cause is elsewhere.
export function makeHealer({ everyMs = 30 * 60_000, againAfterMs = 3 * 60_000, batch = 40, max = 20_000, now = Date.now } = {}) {
  const healedAt = new Map(); // participant -> when he was last put in a batch
  const queue = new Set();
  const stat = { asked: 0, queued: 0, healed: 0, failed: 0, batches: 0, again: 0, lid: 0, pn: 0, phone: 0, linked: 0 };
  return {
    /** A refused group ask of this device. */
    note(participant) {
      const p = String(participant ?? '');
      if (!p.includes('@')) return;
      const t = now();
      stat.asked += 1;
      if (isLid(p)) stat.lid += 1; else stat.pn += 1;
      const device = Number(p.split('@')[0].split(':')[1] || 0);
      if (device > 0) stat.linked += 1; else stat.phone += 1;
      const at = healedAt.get(p);
      if (at !== undefined) {
        if (t - at > againAfterMs) stat.again += 1;
        if (t - at < everyMs) return;
      }
      if (queue.size < max && !queue.has(p)) { queue.add(p); stat.queued += 1; }
    },
    /** The next devices to heal - at most `batch`; they count as healed from now. */
    take() {
      const t = now();
      const out = [];
      for (const p of queue) {
        out.push(p);
        queue.delete(p);
        healedAt.delete(p);
        healedAt.set(p, t);
        if (out.length >= batch) break;
      }
      // The oldest go first (a Map keeps the order they were put in).
      while (healedAt.size > max) healedAt.delete(healedAt.keys().next().value);
      return out;
    },
    done(n, ok) { stat.batches += 1; if (ok) stat.healed += n; else stat.failed += n; },
    get waiting() { return queue.size; },
    stats: () => ({ ...stat, waiting: queue.size, known: healedAt.size }),
  };
}

// ---- A message that never decrypts is not asked for without end ---------------
/**
 * `failed(id)` — the message failed to decrypt once more. -> true when it has
 * already been asked for `max` times: the patch then acknowledges it and stops
 * (baileysPatch.js undecryptable_is_not_asked_forever). Kept `ttlMs` per message.
 */
export function makeUndecryptable({ max = 5, ttlMs = 60 * 60_000, cap = 5_000, now = Date.now } = {}) {
  const seen = new Map(); // id -> { n, t }
  const stat = { messages: 0, stopped: 0 };
  return {
    failed(id) {
      if (!id) return false;
      const t = now();
      let e = seen.get(id);
      if (!e || t - e.t > ttlMs) {
        e = { n: 0, t };
        seen.delete(id);
        seen.set(id, e);
        // The oldest go first (a Map keeps the order they were put in).
        while (seen.size > cap) seen.delete(seen.keys().next().value);
      }
      e.n += 1;
      if (e.n <= max) return false;
      if (e.n === max + 1) stat.messages += 1;
      stat.stopped += 1;
      return true;
    },
    totals: () => ({ ...stat }),
  };
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

// ---- A small cache with a time limit (Baileys' CacheStore) ------------------------
/** get / set / del / flushAll, and mget / mset as Baileys asks for many users at once. */
export function makeTtlCache({ ttlMs, max = 200_000, now = Date.now } = {}) {
  const held = new Map(); // key -> { v, exp }
  const live = (key, t) => {
    const e = held.get(key);
    if (!e) return undefined;
    if (e.exp <= t) { held.delete(key); return undefined; }
    return e.v;
  };
  const put = (key, value, t) => {
    held.set(key, { v: value, exp: t + ttlMs });
    if (held.size > max) {
      for (const [k, e] of held) if (e.exp <= t) held.delete(k);
      if (held.size > max) { let drop = held.size - Math.floor(max * 0.9); for (const k of held.keys()) { if (drop-- <= 0) break; held.delete(k); } }
    }
  };
  return {
    get: (key) => live(key, now()),
    set: (key, value) => { put(key, value, now()); return true; },
    del: (key) => { held.delete(key); },
    flushAll: () => { held.clear(); },
    mget: (keys) => {
      const t = now();
      const out = {};
      for (const key of keys || []) { const v = live(key, t); if (v !== undefined) out[key] = v; }
      return out;
    },
    mset: (entries) => { const t = now(); for (const { key, value } of entries || []) put(key, value, t); return true; },
    size: () => held.size,
    /** How long ago this key's value was put (the askers' probe: how old a member's device list is). */
    ageMs: (key) => { const e = held.get(key); const t = now(); return e && e.exp > t ? t - (e.exp - ttlMs) : null; },
  };
}

// ---- Who asks again, and why (2026-11-24, Michael: «אני רוצה לפתור את זה מהשורש») ----
// ~48 devices asked for every post of 058-711-5623 again; 98% were refused by the
// limit, and 8,369 asks in 22 minutes came from devices healed already - forgetting
// them and healing them did not stop them. A post carries the group's key only to
// the devices on the CACHED list of each member (Baileys getUSyncDevices; the
// bridge keeps that list DEVICES_TTL_MIN = 60 minutes, Baileys' own default is 5).
// A device not on that list (a new WhatsApp Web, a new phone, a reinstall) never
// gets the key until the list is read again - and asks after every post.
// This only looks and counts (nothing is sent, nothing changes): for every device
// that asks for a group post again - is his member's device list cached, is this
// device on it, how old is the list, and how many times he asked.

/** The asks of the last `windowMs`, by device: what was found, and how often each asked. */
export function makeAskerProbe({ windowMs = 60 * 60_000, maxDevices = 50_000, now = Date.now } = {}) {
  const totals = { asks: 0, got_key_in_post: 0, no_key_in_post: 0, post_unknown: 0, no_list: 0, listed: 0, not_listed: 0, via_pn: 0, lid: 0, pn: 0, phone: 0, linked: 0, answered: 0, refused: 0 };
  const byDevice = new Map(); // participant -> { asks, first, last, listed, notListed, noList, listAgeMs }
  const listAges = [];        // age of the cached list at a not_listed ask (ms), the last 500
  return {
    /**
     * One ask: `participant` the asking device's jid, `devicesCache` the number's
     * cache of member devices (user -> [{ user, device, ... }]), `answered` true
     * when a resend went out.
     */
    note({ participant, altParticipant, devicesCache, answered, keyInPost }) {
      const jid = String(participant || '');
      const user = userOf(jid);
      if (!user) return;
      const device = deviceOf(jid);
      const t = now();
      totals.asks += 1;
      totals[isLid(jid) ? 'lid' : 'pn'] += 1;
      totals[device === 0 ? 'phone' : 'linked'] += 1;
      totals[answered ? 'answered' : 'refused'] += 1;
      // Did the post he asks for carry the group's key to this very device? (makePostKeys)
      const k = keyInPost === 'got' ? 'got_key_in_post' : keyInPost === 'not' ? 'no_key_in_post' : 'post_unknown';
      totals[k] += 1;
      let list;
      let listUser = user;
      try { list = devicesCache?.get?.(user); } catch (_) { list = undefined; }
      // A group of phone numbers keeps its members' devices under their numbers: the asker's LID turned into his number.
      if (!Array.isArray(list) && altParticipant) {
        try { const alt = devicesCache?.get?.(userOf(altParticipant)); if (Array.isArray(alt)) { list = alt; listUser = userOf(altParticipant); totals.via_pn += 1; } } catch (_) { /* not known */ }
      }
      let found;
      if (!Array.isArray(list)) found = 'no_list';
      else found = list.some((d) => Number(d?.device ?? 0) === device) ? 'listed' : 'not_listed';
      totals[found] += 1;
      let age = null;
      if (found === 'not_listed') {
        try { age = devicesCache?.ageMs?.(listUser) ?? null; } catch (_) { age = null; }
        if (age != null) { listAges.push(age); if (listAges.length > 500) listAges.shift(); }
      }
      let e = byDevice.get(jid);
      if (!e || t - e.last > windowMs) e = { asks: 0, first: t, last: t, listed: 0, notListed: 0, noList: 0, gotKey: 0, noKey: 0 };
      e.asks += 1;
      e.last = t;
      if (found === 'listed') e.listed += 1; else if (found === 'not_listed') e.notListed += 1; else e.noList += 1;
      if (keyInPost === 'got') e.gotKey += 1; else if (keyInPost === 'not') e.noKey += 1;
      byDevice.delete(jid);
      byDevice.set(jid, e); // newest last, so the oldest go first when full
      if (byDevice.size > maxDevices) for (const k of byDevice.keys()) { byDevice.delete(k); if (byDevice.size <= maxDevices * 0.9) break; }
    },
    /** For /diag and the minute's log line. */
    stats() {
      const t = now();
      const rep = { devices: 0, once: 0, two_to_five: 0, six_plus: 0, six_plus_not_listed: 0, six_plus_listed: 0, six_plus_mostly_got_key: 0, six_plus_mostly_no_key: 0 };
      const top = [];
      for (const [jid, e] of byDevice) {
        if (t - e.last > windowMs) continue;
        rep.devices += 1;
        if (e.asks === 1) rep.once += 1; else if (e.asks <= 5) rep.two_to_five += 1; else {
          rep.six_plus += 1;
          if (e.notListed > e.listed) rep.six_plus_not_listed += 1; else if (e.listed > 0) rep.six_plus_listed += 1;
          if (e.gotKey > e.noKey) rep.six_plus_mostly_got_key += 1; else if (e.noKey > e.gotKey) rep.six_plus_mostly_no_key += 1;
        }
        top.push({ jid, asks: e.asks, got_key: e.gotKey, no_key: e.noKey, listed: e.listed, not_listed: e.notListed, no_list: e.noList, minutes: Math.round((e.last - e.first) / 60_000) });
      }
      top.sort((a, b) => b.asks - a.asks);
      const sorted = [...listAges].sort((a, b) => a - b);
      const mid = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] / 60_000) : null;
      // The device's own number is kept to its last 4 digits (a LID is not a phone number, kept the same way).
      const mask = (jid) => { const u = userOf(jid); return `…${u.slice(-4)}:${deviceOf(jid)}@${String(jid).split('@')[1] || ''}`; };
      return { ...totals, repeat: rep, not_listed_list_age_min_p50: mid, top: top.slice(0, 8).map((x) => ({ ...x, jid: mask(x.jid) })) };
    },
  };
}

/**
 * Which devices each of our group posts carried the group's key to (the patch's
 * onGroupPost, every group post - also one that carried it to nobody). Kept
 * `ttlMs`, at most `max` posts. -> 'got' | 'not' | 'unknown' for (msgId, device).
 */
/** A device the same however written ('111@lid' = '111:0@lid'; a LID and a number stay apart). */
const deviceKey = (jid) => `${userOf(jid)}:${deviceOf(jid)}@${String(jid ?? '').split('@')[1] || ''}`;

export function makePostKeys({ ttlMs = 30 * 60_000, max = 4_000, now = Date.now } = {}) {
  const posts = new Map(); // msgId -> { at, to: Set<jid> }
  let noted = 0;
  return {
    note(msgId, recipients) {
      if (!msgId) return;
      const t = now();
      posts.delete(msgId);
      posts.set(msgId, { at: t, to: new Set((recipients || []).map(deviceKey)) });
      noted += 1;
      if (posts.size > max) for (const k of posts.keys()) { posts.delete(k); if (posts.size <= max * 0.9) break; }
    },
    keyIn(msgId, ...jids) {
      const p = posts.get(msgId);
      if (!p || now() - p.at > ttlMs) return 'unknown';
      return jids.some((j) => j && p.to.has(deviceKey(j))) ? 'got' : 'not';
    },
    stats: () => ({ posts: posts.size, noted }),
  };
}

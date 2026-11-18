// ---- Retry receipts: a limit (2026-10-28) -----------------------------------
// 058-711-5623, 18:00–19:16 UTC: members' phones asked again and again for
// our group posts ("retry receipt") — 438 resends in one hour, 1,631 in the
// next (a healthy number: about none). Each resend makes Baileys fetch new
// keys for that member (assertSessions, forced) and forget who holds the
// group's key, so the next post carries keys to every device in the group.
// The socket choked: private messages stopped arriving at 19:05, WhatsApp
// rejected the stale keys (smax-invalid) and ended the stream, 139 queries
// timed out at once — and the number stayed "connected but deaf" until it was
// paired again.
//
// Baileys asks its retry counter before it resends (`willSendMessageAgain`:
// counter < maxMsgRetryCount, 5); a counter that says "already sent too many
// times" skips the whole resend — no key fetch, no group key forgotten. So
// the counter we give it answers that for a resend of OUR message that is
// old, or one too many in the last minute. Everything else — and every key
// of a message that is not ours (an incoming message we ask the sender to
// send again uses the same counter) — is counted as Baileys always did.

/** Above Baileys' maxMsgRetryCount (5): "sent too many times", not resent. */
export const RETRY_SKIP_COUNT = 99;

/**
 * A group post resent after 15 minutes helps nobody — the ride is gone — and
 * a group retry fans out to every device; a private answer to a driver is
 * worth resending for longer, and asks for little.
 */
export const RETRY_RULES = {
  // perAsker (2026-11-18): one device is answered `count` times in `windowMs`,
  // whatever the minute's limit — and no more, so the minute's limit serves
  // distinct members. A member refused is never healed (an answered resend
  // fetches him fresh keys — assertSessions; a refused one gets nothing), so
  // 058-711-5623 answered 90 a minute of 2,400 asks a minute at 15:23 on
  // 2026-11-17 (35 posts a minute): the same devices asked again on every post.
  group: { maxAgeMs: 15 * 60_000, perMinute: 30, perAsker: { count: 2, windowMs: 10 * 60_000 } },
  private: { maxAgeMs: 2 * 60 * 60_000, perMinute: 60 },
};

/**
 * The number's own devices (Michael's phone is the primary of 058-711-5623;
 * the bridge is a linked device of it): their asks are answered always, outside
 * every limit — his own post stood on his phone as "בהמתנה להודעה זו" when the
 * minute's limit refused him with the rest (2026-11-17 15:23, 2026-11-15, 2026-11-11).
 * `me` = creds.me ({ id, lid }); a participant under either name is his.
 */
export function isOwnParticipant(participant, me) {
  const user = (jid) => String(jid ?? '').split('@')[0].split(':')[0].split('_')[0];
  const p = user(participant);
  if (!p || !me) return false;
  return [me.id, me.lid].some((j) => j && user(j) === p);
}

/**
 * The group limit may be set while the bridge runs (POST /retry-mode
 * { groupPerMinute }, 2026-11-15): since the retry patch a resend goes to the
 * asking device alone, so 30 a minute left most members who asked without the
 * post ("בהמתנה להודעה זו" on their phones) — 22,000 asks refused in 18 hours
 * against 1,200 answered. Never under the first limit, never without a ceiling.
 */
export const GROUP_PER_MINUTE = { min: 30, max: 600 };

/** A limit asked for -> a whole number inside the bounds; the base when it is none. */
export function parseGroupLimit(raw, base = RETRY_RULES.group.perMinute) {
  if (raw == null || raw === '' || typeof raw === 'boolean') return base;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return base;
  return Math.min(GROUP_PER_MINUTE.max, Math.max(GROUP_PER_MINUTE.min, n));
}

/** One retry asks the counter several times; it gets one answer. */
const VERDICT_MS = 30_000;
/** As Baileys' own counter (NodeCache, stdTTL 1h). */
const COUNT_TTL_MS = 60 * 60_000;
const SWEEP_MS = 60_000;

/**
 * May this resend of our message go: 'ok', 'too_old', 'too_often' (this device
 * had its share of the window) or 'too_many' (the minute's limit). An own
 * device is 'ok' whenever the message is not too old.
 */
export function retryVerdict({ ageMs, group, recentCount, askerCount = 0, own = false }, rules = RETRY_RULES) {
  const r = group ? rules.group : rules.private;
  if (!(ageMs <= r.maxAgeMs)) return 'too_old';
  if (own) return 'ok';
  if (r.perAsker && askerCount >= r.perAsker.count) return 'too_often';
  if (recentCount >= r.perMinute) return 'too_many';
  return 'ok';
}

/** The asker of `${msgId}:${participant}` — the participant (a device), or ''. */
export function retryKeyParticipant(key) {
  const k = String(key ?? '');
  const at = k.indexOf(':');
  return at < 0 ? '' : k.slice(at + 1);
}

/** `${msgId}:${participant}` — the participant may hold ':' (a device). */
export function retryKeyId(key) {
  const k = String(key ?? '');
  const at = k.indexOf(':');
  return at < 0 ? k : k.slice(0, at);
}

/**
 * Baileys' msgRetryCounterCache for one number. `ourMessage(id)` is the sent
 * message ({ ts, group }) or nothing; `onSkip(why, kind, id, key)` is told of
 * every resend not made, `onAllow(key, kind)` of every one let through. A
 * number keeps one counter across its sockets, so a restart does not start
 * the storm over.
 */
export function makeRetryCounter({ ourMessage, onSkip, onAllow, isOwn, rules = RETRY_RULES, now = Date.now }) {
  const counts = new Map(); // key -> { v, exp }
  const verdicts = new Map(); // key -> { verdict, exp }
  const recent = { group: [], private: [] }; // times of resends let through
  const answered = new Map(); // participant -> times of group resends let through to him
  let sweptAt = 0;

  const sweep = (t) => {
    if (t - sweptAt < SWEEP_MS) return;
    sweptAt = t;
    for (const [k, e] of counts) if (e.exp <= t) counts.delete(k);
    for (const [k, e] of verdicts) if (e.exp <= t) verdicts.delete(k);
    const win = rules.group?.perAsker?.windowMs ?? 0;
    for (const [p, list] of answered) {
      const kept = list.filter((x) => t - x < win);
      if (kept.length) answered.set(p, kept); else answered.delete(p);
    }
  };

  const verdictOf = (key, mine, t) => {
    const held = verdicts.get(key);
    if (held && held.exp > t) return held.verdict;
    // A message saved before this guard has no group mark: held to the group's rule.
    const kind = mine.group === false ? 'private' : 'group';
    recent[kind] = recent[kind].filter((x) => t - x < 60_000);
    const participant = retryKeyParticipant(key);
    let own = false;
    try { own = kind === 'group' && !!isOwn?.(participant); } catch (_) { own = false; }
    const win = rules.group?.perAsker?.windowMs ?? 0;
    const mine_ = kind === 'group' && participant ? (answered.get(participant) || []).filter((x) => t - x < win) : [];
    const verdict = retryVerdict({ ageMs: t - Number(mine.ts), group: kind === 'group', recentCount: recent[kind].length, askerCount: mine_.length, own }, rules);
    if (verdict === 'ok') {
      // An own device is answered outside the minute's limit.
      if (!own) recent[kind].push(t);
      if (kind === 'group' && participant) answered.set(participant, [...mine_, t]);
      // Told once per resend let through (`key` = `${msgId}:${participant}`).
      try { onAllow?.(key, kind, own); } catch (_) { /* a count never stops the answer */ }
    } else {
      try { onSkip?.(verdict, kind, retryKeyId(key), key); } catch (_) { /* a log line never stops the answer */ }
    }
    verdicts.set(key, { verdict, exp: t + VERDICT_MS });
    return verdict;
  };

  return {
    get(key) {
      const t = now();
      sweep(t);
      let mine;
      try { mine = ourMessage(retryKeyId(key)); } catch (_) { mine = undefined; }
      if (mine && verdictOf(key, mine, t) !== 'ok') return RETRY_SKIP_COUNT;
      const e = counts.get(key);
      if (!e) return undefined;
      if (e.exp <= t) { counts.delete(key); return undefined; }
      return e.v;
    },
    set(key, value) {
      const t = now();
      sweep(t);
      counts.set(key, { v: value, exp: t + COUNT_TTL_MS });
      return true;
    },
    del(key) {
      verdicts.delete(key);
      return counts.delete(key) ? 1 : 0;
    },
    flushAll() {
      counts.clear();
      verdicts.clear();
      answered.clear();
      recent.group = [];
      recent.private = [];
    },
  };
}

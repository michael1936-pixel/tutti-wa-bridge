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
  group: { maxAgeMs: 15 * 60_000, perMinute: 30 },
  private: { maxAgeMs: 2 * 60 * 60_000, perMinute: 60 },
};

/** One retry asks the counter several times; it gets one answer. */
const VERDICT_MS = 30_000;
/** As Baileys' own counter (NodeCache, stdTTL 1h). */
const COUNT_TTL_MS = 60 * 60_000;
const SWEEP_MS = 60_000;

/** May this resend of our message go: 'ok', 'too_old' or 'too_many'. */
export function retryVerdict({ ageMs, group, recentCount }, rules = RETRY_RULES) {
  const r = group ? rules.group : rules.private;
  if (!(ageMs <= r.maxAgeMs)) return 'too_old';
  if (recentCount >= r.perMinute) return 'too_many';
  return 'ok';
}

/** `${msgId}:${participant}` — the participant may hold ':' (a device). */
export function retryKeyId(key) {
  const k = String(key ?? '');
  const at = k.indexOf(':');
  return at < 0 ? k : k.slice(0, at);
}

/**
 * Baileys' msgRetryCounterCache for one number. `ourMessage(id)` is the sent
 * message ({ ts, group }) or nothing; `onSkip(why, kind, id)` is told of
 * every resend not made. A number keeps one counter across its sockets, so a
 * restart does not start the storm over.
 */
export function makeRetryCounter({ ourMessage, onSkip, rules = RETRY_RULES, now = Date.now }) {
  const counts = new Map(); // key -> { v, exp }
  const verdicts = new Map(); // key -> { verdict, exp }
  const recent = { group: [], private: [] }; // times of resends let through
  let sweptAt = 0;

  const sweep = (t) => {
    if (t - sweptAt < SWEEP_MS) return;
    sweptAt = t;
    for (const [k, e] of counts) if (e.exp <= t) counts.delete(k);
    for (const [k, e] of verdicts) if (e.exp <= t) verdicts.delete(k);
  };

  const verdictOf = (key, mine, t) => {
    const held = verdicts.get(key);
    if (held && held.exp > t) return held.verdict;
    // A message saved before this guard has no group mark: held to the group's rule.
    const kind = mine.group === false ? 'private' : 'group';
    recent[kind] = recent[kind].filter((x) => t - x < 60_000);
    const verdict = retryVerdict({ ageMs: t - Number(mine.ts), group: kind === 'group', recentCount: recent[kind].length }, rules);
    if (verdict === 'ok') recent[kind].push(t);
    else {
      try { onSkip?.(verdict, kind, retryKeyId(key)); } catch (_) { /* a log line never stops the answer */ }
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
      recent.group = [];
      recent.private = [];
    },
  };
}

// Which of the number's questions to WhatsApp go unanswered.
//
// Michael, 2026-11-28, on a review of the connections («תעשה סקירה ותראה מה התקלות מהחיבורים
// לוואצפ … שהכל רץ חלק») and then «כן, תבנה מעקב»: 053-375-3887 was restarted 19 times in
// a week for "query_timeouts" (058-711-5623 five times, four of them within 20 seconds of
// 3887's) — each time ten questions in a minute got no answer while the groups' messages
// kept arriving, and after two of the restarts the number heard nothing for three minutes.
// Baileys says only "timed out waiting for message" and the id; nothing says WHAT was asked.
//
// This only counts. Every question is named when it leaves (baileysPatch QUERY_EDITS →
// globalThis.__bridgeQuery.sent), and a timeout is given that name; /diag shows the totals,
// and a stuck-socket restart carries the kinds of its last minute. Pure — no socket, no clock
// of its own; test/queryTrace.test.js.

const tagOf = (n) => (n && typeof n === 'object' && typeof n.tag === 'string' ? n.tag : '');
const kids = (n) => (Array.isArray(n?.content) ? n.content.filter((c) => tagOf(c)) : []);

/** Where the question goes: a group, a person, or WhatsApp itself (nothing). */
function whereOf(to) {
  const t = String(to || '');
  if (t.endsWith('@g.us')) return 'group';
  if (t.endsWith('@newsletter')) return 'channel';
  if (!t || t === 's.whatsapp.net' || t === '@s.whatsapp.net') return '';
  return t.includes('@') ? 'user' : '';
}

/**
 * A short name for a question: its namespace, get/set, what it asks, and to whom.
 * "usync:get:usync/message/query[devices]x3", "encrypt:get:key", "w:g2:get:query:group",
 * "w:p:get:ping", "w:profile:picture:get:picture:user".
 */
export function kindOfQuery(node) {
  const a = node?.attrs || {};
  const first = kids(node)[0] || null;
  let what = tagOf(first);
  if (what === 'usync') {
    const ua = first.attrs || {};
    const asked = kids(kids(first).find((c) => c.tag === 'query')).map((c) => c.tag).join('+');
    const users = kids(kids(first).find((c) => c.tag === 'list')).length;
    // How many people one question names says much about why it is slow: 1, 2-5, 6-20, 21+.
    const size = users <= 1 ? '' : users <= 5 ? 'x2-5' : users <= 20 ? 'x6-20' : 'x21+';
    what = `usync/${ua.context || '?'}/${ua.mode || '?'}${asked ? `[${asked}]` : ''}${size}`;
  } else if (what === 'key' || what === 'key_fetch') {
    const users = kids(first).length;
    what += users <= 1 ? '' : users <= 5 ? 'x2-5' : users <= 20 ? 'x6-20' : 'x21+';
  }
  return [a.xmlns || tagOf(node) || '?', a.type || '', what, whereOf(a.to)].filter(Boolean).join(':');
}

/**
 * The trace of one number.
 *   sent(id, node)      — a question left
 *   timedOut(id, opts)  — Baileys gave up on it; → its kind ("unknown" for an id never seen)
 *   recentKinds(ms)     — the kinds that timed out in the last ms, with how many
 *   stats()             — for /diag
 */
export function makeQueryTrace({ max = 3000, keepMs = 120_000, lastMax = 40, now = Date.now } = {}) {
  const open = new Map(); // id → { kind, at }
  const sent = Object.create(null);
  const timeouts = Object.create(null);
  const last = [];
  let asked = 0;
  let lost = 0;
  let spared = 0;

  const prune = (t) => {
    if (open.size <= max / 2) return;
    for (const [id, e] of open) {
      if (t - e.at > keepMs || open.size > max) open.delete(id);
      else break; // a Map keeps the order they were put in: the rest are newer
    }
  };

  return {
    sent(id, node) {
      if (id == null) return;
      const t = now();
      const kind = kindOfQuery(node);
      asked += 1;
      sent[kind] = (sent[kind] || 0) + 1;
      open.set(String(id), { kind, at: t });
      prune(t);
    },
    /** opts.spared — a timeout the stuck-socket rule does not count (a LID question already given up on). */
    timedOut(id, opts = {}) {
      const t = now();
      const e = id == null ? null : open.get(String(id));
      if (e) open.delete(String(id));
      const kind = e?.kind || 'unknown';
      lost += 1;
      if (opts.spared) spared += 1;
      timeouts[kind] = (timeouts[kind] || 0) + 1;
      last.push({ at: t, kind, waitedMs: e ? t - e.at : null, ...(opts.spared ? { spared: true } : {}) });
      while (last.length > lastMax) last.shift();
      return kind;
    },
    recentKinds(windowMs = 60_000) {
      const t = now();
      const out = {};
      for (const x of last) if (t - x.at <= windowMs && !x.spared) out[x.kind] = (out[x.kind] || 0) + 1;
      return out;
    },
    stats() {
      const top = (o) => Object.fromEntries(Object.entries(o).sort((x, y) => y[1] - x[1]).slice(0, 25));
      return {
        asked, timed_out: lost, spared, open: open.size,
        sent: top(sent), timeouts: top(timeouts),
        last: last.slice(-15).map((x) => ({ at: new Date(x.at).toISOString(), kind: x.kind, waitedMs: x.waitedMs, ...(x.spared ? { spared: true } : {}) })),
      };
    },
  };
}

/** "usync…×7, encrypt:get:key×3" — the kinds of a restart, in one line of the watchdog's event. */
export function kindsLine(kinds) {
  return Object.entries(kinds || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ');
}

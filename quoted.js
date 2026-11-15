// =============================================================================
// The message a member answered (a swipe-reply), read from whatever shape his
// WhatsApp sent it in. Pure — no Baileys, no socket (test/quoted.test.js).
//
// 2026-11-15: a driver's "ת" on ANOTHER dispatcher's post reached the server
// with no quote at all, so the server took it for a bare "ת" and gave him the
// station's own open ride («ק שלח בפרטי», «מתי אוסף מתי מוסר?»). The quote was
// read only from three message kinds and only when the quoted post lay bare;
// a quote under any other kind, or of a post inside a wrapper (disappearing
// messages, view-once, an edit), was dropped. The id of the quoted post is
// handed on even when its words cannot be read: the server stops on it.
// =============================================================================

const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage',
];

/** The message inside its wrappers (disappearing, view-once, captioned document, edit). */
export function innerMessage(message) {
  let m = message || null;
  for (let depth = 0; m && depth < 5; depth++) {
    const key = WRAPPERS.find((w) => m[w]?.message);
    if (!key) break;
    m = m[key].message;
  }
  return m || null;
}

/** The words of a message: plain text, a reply's text, a caption. '' when it has none. */
export function messageWords(message) {
  const m = innerMessage(message);
  const text = m?.conversation
    || m?.extendedTextMessage?.text
    || m?.imageMessage?.caption
    || m?.videoMessage?.caption
    || m?.documentMessage?.caption
    || '';
  return typeof text === 'string' ? text : '';
}

/** The post a message answers: its words (null when unreadable) and its WhatsApp id (null when none). */
export function quotedOf(message) {
  const m = innerMessage(message);
  if (!m || typeof m !== 'object') return { text: null, id: null };
  let ctx = null;
  for (const part of Object.values(m)) {
    const c = part && typeof part === 'object' ? part.contextInfo : null;
    if (c && (c.stanzaId || c.quotedMessage)) { ctx = c; break; }
  }
  if (!ctx) return { text: null, id: null };
  const words = ctx.quotedMessage ? messageWords(ctx.quotedMessage).trim() : '';
  return { text: words || null, id: ctx.stanzaId ? String(ctx.stanzaId) : null };
}

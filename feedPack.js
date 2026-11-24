// =============================================================================
// Group messages leave for the server in packs (2026-11-21, Michael: 200
// messages a second).
//
// The server's API layer tops out at about 125 calls a second, and a group
// message sent alone costs it ~6 calls. A pack of messages in ONE request costs
// about the same ~6 calls for the whole pack (the server's
// whatsapp-group-feed-inbound takes `{ batch: [...] }` and answers
// `{ results: [...] }`, one per message, in order).
//
// No waiting is added: while a lane is free a message leaves at once, alone,
// exactly as before. Only when all the lanes are busy do messages gather, and
// the next free lane takes everything that gathered (up to `max`) as one pack.
// So a quiet hour is unchanged and a busy one packs itself, more the busier.
//
// Nothing is dropped: a pack the server does not take as a pack (an older
// function, a refusal, a failure) is sent again message by message, the old
// way; after a refusal the packs rest for a minute and everything goes alone.
//
// No flood (2026-11-24): a pack that FAILS (5xx, a network error, a timeout) is
// first sent once more as the same pack - to the next copy of the function -
// and only if that fails too do its messages go alone, a few at a time
// (`aloneAtOnce`), never all together. Before, every failed pack became up to
// `max` requests at the same moment: with 12 lanes x 60 that is ~720 requests
// at once into a server that has just failed under load.
// =============================================================================

export function makeFeedPacker({
  post,                       // async (body) => ({ status, text })
  lanes = 3,                  // requests on their way at once while packs work
  aloneLanes = 64,            // ... while they rest (the old limit)
  max = 40,                   // messages in one pack
  restMs = 60_000,            // after a refusal, no packs for this long
  retryMs = 3_000,            // the pause before the second try of a lone message (and of a failed pack)
  aloneAtOnce = 4,            // a failed pack's messages: this many alone at a time
  onResult = () => {},        // (payload, { status, body, attempt, packed, queued })
  onError = () => {},         // (payload | null, err, { attempt, packed })
  onBacklog = () => {},       // ({ queued, busy })
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const waiting = [];
  let busy = 0;
  let restUntil = 0;
  let warnAt = 0;
  let failedPacks = 0;        // pack tries not taken (shown in /diag)
  let sentAloneAfter = 0;     // messages that went alone after their pack was not taken

  const packsOn = () => now() >= restUntil;

  // Stamped when it really leaves (after its turn in the line), and the wait in
  // the line said apart — the server's feed_timing shows both.
  const stamp = (payload, first) => {
    if (first && typeof payload.bridge_sent_ms === 'number') payload.bridge_queue_ms = now() - payload.bridge_sent_ms;
    payload.bridge_sent_ms = now();
  };

  // One message, the old way: a 5xx or a network error is tried once more.
  async function sendAlone(payload, first = true) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        stamp(payload, first && attempt === 1);
        const resp = await post(payload);
        onResult(payload, { status: resp.status, body: String(resp.text || '').slice(0, 200), attempt, packed: 1, queued: waiting.length });
        if (resp.status < 500 || attempt === 2) return;
      } catch (err) {
        onError(payload, err, { attempt, packed: 1 });
        if (attempt === 2) return;
      }
      await sleep(retryMs);
    }
  }

  // A failed pack's messages alone, a few at a time - never all of them at once.
  async function sendFewAtOnce(payloads) {
    const step = Math.max(1, aloneAtOnce);
    sentAloneAfter += payloads.length;
    for (let i = 0; i < payloads.length; i += step) {
      await Promise.all(payloads.slice(i, i + step).map((p) => sendAlone(p, false)));
    }
  }

  async function sendPack(payloads) {
    if (payloads.length === 1) return sendAlone(payloads[0]);
    for (let attempt = 1; attempt <= 2; attempt++) {
      let refused = false;
      try {
        payloads.forEach((p) => stamp(p, attempt === 1));
        const resp = await post({ batch: payloads });
        let answer = null;
        try { answer = JSON.parse(resp.text || ''); } catch (_) { /* not a pack's answer */ }
        const results = answer && Array.isArray(answer.results) ? answer.results : null;
        if (resp.status === 200 && results && results.length === payloads.length) {
          payloads.forEach((p, i) => {
            const r = results[i] || {};
            onResult(p, { status: Number(r.status) || 200, body: JSON.stringify(r).slice(0, 200), attempt, packed: payloads.length, queued: waiting.length });
          });
          return;
        }
        // Not taken as a pack (an older function answers 400): the old way, and no packs for a while.
        refused = resp.status < 500;
        onError(null, new Error(`pack_not_taken_${resp.status}`), { attempt, packed: payloads.length });
      } catch (err) {
        onError(null, err, { attempt, packed: payloads.length });
      }
      failedPacks++;
      if (refused) { restUntil = now() + restMs; break; }
      // A failure (5xx, network, timeout): the same pack once more - it goes to the next copy.
      await sleep(retryMs);
    }
    await sendFewAtOnce(payloads);
  }

  function pump() {
    while (waiting.length > 0 && busy < (packsOn() ? lanes : aloneLanes)) {
      const take = waiting.splice(0, packsOn() ? max : 1);
      busy++;
      sendPack(take.map((w) => w.payload))
        .catch(() => { /* reported inside */ })
        .finally(() => {
          busy--;
          take.forEach((w) => w.done());
          pump();
        });
    }
    if (waiting.length > 200 && now() - warnAt > 30_000) {
      warnAt = now();
      onBacklog({ queued: waiting.length, busy });
    }
  }

  return {
    /** Resolves when the message was answered (or given up on, as before). */
    add(payload) {
      return new Promise((done) => {
        waiting.push({ payload, done });
        pump();
      });
    },
    stats: () => ({ queued: waiting.length, busy, packs: packsOn(), failed_packs: failedPacks, sent_alone_after: sentAloneAfter }),
  };
}

/**
 * Several copies of the server's function (2026-11-24, Michael: «חייב שזה יגיע ל 1000
 * לפחות עם 0.7»): one copy tops out at ~400 messages a second - its requests slow each
 * other down - and three copies side by side took 1,027 a second with every request
 * answered (load test, 12 lanes x 60). Each request goes to the next copy in turn; a
 * pack the copy did not take is sent again message by message, each to the next copy.
 * One URL: exactly the poster of before.
 */
export function feedPosters({ urls, secret, fetchImpl = fetch, timeoutMs = 60_000 }) {
  const list = (urls || []).map((u) => String(u || '').trim()).filter(Boolean);
  if (list.length <= 1) return feedPoster({ url: list[0] || '', secret, fetchImpl, timeoutMs });
  const posters = list.map((url) => feedPoster({ url, secret, fetchImpl, timeoutMs }));
  let turn = 0;
  return (body) => posters[turn++ % posters.length](body);
}

/** The copies' URLs: GROUP_FEED_WEBHOOK_URLS (comma separated), else the one GROUP_FEED_WEBHOOK_URL. */
export function feedUrls(env = process.env) {
  const many = String(env.GROUP_FEED_WEBHOOK_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return many.length ? many : [String(env.GROUP_FEED_WEBHOOK_URL || '')];
}

/** The request itself: the same headers a lone message always carried. */
export function feedPoster({ url, secret, fetchImpl = fetch, timeoutMs = 60_000 }) {
  return async (body) => {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-region': 'eu-central-1',
        ...(secret ? { 'X-Webhook-Secret': secret } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text().catch(() => '');
    return { status: resp.status, text };
  };
}

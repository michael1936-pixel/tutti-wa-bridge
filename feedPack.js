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
// =============================================================================

export function makeFeedPacker({
  post,                       // async (body) => ({ status, text })
  lanes = 3,                  // requests on their way at once while packs work
  aloneLanes = 64,            // ... while they rest (the old limit)
  max = 40,                   // messages in one pack
  restMs = 60_000,            // after a refusal, no packs for this long
  retryMs = 3_000,            // the pause before the second try of a lone message
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

  async function sendPack(payloads) {
    if (payloads.length === 1) return sendAlone(payloads[0]);
    let refused = false;
    try {
      payloads.forEach((p) => stamp(p, true));
      const resp = await post({ batch: payloads });
      let answer = null;
      try { answer = JSON.parse(resp.text || ''); } catch (_) { /* not a pack's answer */ }
      const results = answer && Array.isArray(answer.results) ? answer.results : null;
      if (resp.status === 200 && results && results.length === payloads.length) {
        payloads.forEach((p, i) => {
          const r = results[i] || {};
          onResult(p, { status: Number(r.status) || 200, body: JSON.stringify(r).slice(0, 200), attempt: 1, packed: payloads.length, queued: waiting.length });
        });
        return;
      }
      // Not taken as a pack (an older function answers 400): the old way, and no packs for a while.
      refused = resp.status < 500;
      onError(null, new Error(`pack_not_taken_${resp.status}`), { attempt: 1, packed: payloads.length });
    } catch (err) {
      onError(null, err, { attempt: 1, packed: payloads.length });
    }
    if (refused) restUntil = now() + restMs;
    else await sleep(retryMs);
    await Promise.all(payloads.map((p) => sendAlone(p, false)));
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
    stats: () => ({ queued: waiting.length, busy, packs: packsOn() }),
  };
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

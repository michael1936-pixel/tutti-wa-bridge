    const result = await s.sock.sendMessage(jid, { text });
    res.json({ ok: true, id: result?.key?.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get('/groups', async (req, res) => {
  try {
    const phone = String(req.query.session || '').replace(/\D/g, '');
    const s = sessions.get(phone);
    if (!s?.sock || s.status !== 'connected') {
      return res.status(409).json({ ok: false, error: 'session not connected', status: s?.status });
    }
    const map = await s.sock.groupFetchAllParticipating();
    const groups = Object.values(map).map((g) => ({
      jid: g.id, name: g.subject,
      participants: Array.isArray(g.participants) ? g.participants.length : null,
      announce: !!g.announce,
    }));
    res.json({ ok: true, groups });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

async function logoutHandler(req, res) {
  const phone = String(req.query.session || req.body?.session || '').replace(/\D/g, '');
  if (!phone) return res.status(400).json({ ok: false, error: 'session required' });
  await wipeAuth(phone);
  res.json({ ok: true });
}
app.post('/logout', logoutHandler);
app.post('/reset', logoutHandler);
app.delete('/session/:session', (req, res) => {
  req.query.session = req.params.session;
  return logoutHandler(req, res);
});
app.post('/session/:session/logout', (req, res) => {
  req.query.session = req.params.session;
  return logoutHandler(req, res);
});

app.listen(PORT, () => {
  log.info({ port: PORT, sessionsDir: SESSIONS_DIR }, 'bridge up');
});

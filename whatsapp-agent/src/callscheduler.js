// callscheduler.js — "mere set time pe mereko call karke update dein"
//
// /callat (or the schedule_jarvis_call AI tool) stores a one-shot item in
// store.data.callSchedules. Every 20 s this loop pops what is due and
// delivers it the best way available, in this order:
//   1. A REAL WhatsApp call (VoIP engine): JARVIS greets, speaks the update,
//      then stays on the line — the owner can talk back / give instructions.
//   2. Engine off/busy/unreachable → a JARVIS voice note + the full text.
// The update is never silently lost. An item whose text starts with "/"
// runs as a live command at fire time ("/brief", "/system", …) so the
// spoken update is fresh, not the text typed hours earlier.

export function startCallScheduleLoop({
  config = {}, store, agent, wavoip = null, whatsapp, log = console,
  intervalMs = 20_000, autoStart = true,
}) {
  let timer = null;
  let stopped = false;
  let firing = false;

  async function deliver(item) {
    let spokenText = String(item.text ?? '').trim();
    let fullText = spokenText;

    if (spokenText.startsWith('/')) {
      const reply = await agent.handle(spokenText, { source: 'scheduled-call' });
      fullText = typeof reply === 'string' ? reply : (reply?.text ?? '');
      spokenText = (agent.spokenFor ? agent.spokenFor(reply) : fullText) || fullText;
      // Screenshots/files produced by the command go to the chat as usual.
      if (reply && typeof reply === 'object' && (reply.image || reply.document || reply.video)) {
        await whatsapp.sendToOwner(reply).catch(() => {});
      }
    }
    if (!spokenText) spokenText = `You asked me to call you now, ${config.jarvisAddress || 'Sir'}.`;

    try {
      if (!wavoip?.isHandlingCalls?.()) {
        throw new Error(wavoip?.status?.().hint || 'VoIP engine ready nahi hai');
      }
      await whatsapp.sendToOwner(`📞 Sir, scheduled call ka waqt ho gaya — JARVIS call kar raha hai:\n“${item.text}”`).catch(() => {});
      await wavoip.callOwner(spokenText);
      log.info?.(`[callscheduler] 📞 scheduled call placed (#${item.id}: ${String(item.text).slice(0, 60)})`);
      return { via: 'call' };
    } catch (err) {
      let audioSent = false;
      try {
        const audio = agent.jarvisAudioReply ? await agent.jarvisAudioReply(spokenText) : null;
        if (audio && typeof audio !== 'string') { await whatsapp.sendToOwner(audio); audioSent = true; }
      } catch { /* text below still carries the update */ }
      await whatsapp.sendToOwner([
        `📞 *Scheduled update* — call nahi lagi, isliye ${audioSent ? 'voice note' : 'text'} bhej raha hoon:`,
        fullText || spokenText,
        `_(wajah: ${err.message})_`,
      ].join('\n\n'));
      log.info?.(`[callscheduler] scheduled #${item.id} delivered as ${audioSent ? 'voice note' : 'text'} (${err.message})`);
      return { via: audioSent ? 'voice-note' : 'text', error: err.message };
    }
  }

  /** One sweep. Exported for tests; the interval calls this too. */
  async function tick(now = Date.now()) {
    if (stopped || firing) return [];
    const due = store.popDueCallSchedules(now);
    if (!due.length) return [];
    firing = true;
    const results = [];
    try {
      for (const item of due) {
        try {
          results.push({ id: item.id, ...(await deliver(item)) });
        } catch (err) {
          log.error?.(`[callscheduler] #${item.id} failed (${err.message}) — retried in 1 min`);
          store.addCallSchedule(item.text, Date.now() + 60_000);
          results.push({ id: item.id, via: 'retry', error: err.message });
        }
      }
    } finally {
      firing = false;
    }
    return results;
  }

  if (autoStart) {
    timer = setInterval(() => { tick().catch((err) => log.error?.(`[callscheduler] ${err.message}`)); }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, stop };
}

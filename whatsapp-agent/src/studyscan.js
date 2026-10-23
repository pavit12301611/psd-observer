// studyscan.js — 📸→🃏 Flashcard photo-scan: textbook page ka photo → OCR →
// brain se cards → study pack me add. OCR + brain injected (prod: existing
// ocr pipeline + ai.complete).

/** Turn OCR text into card JSON via the brain. Fallback: naive Q/A split. */
export async function cardsFromText(text, opts = {}) {
  const { makeCards } = opts;
  const body = String(text ?? '').trim();
  if (body.length < 20) return { ok: false, error: '📸 Is photo se itna text nahi mila — saaf photo lo.' };
  if (typeof makeCards === 'function') {
    try {
      const cards = await makeCards(body);
      if (cards?.length) return { ok: true, cards };
    } catch { /* fallback below */ }
  }
  // naive fallback: sentences with ":" or " — " become Q:A
  const cards = body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => {
      const m = line.match(/^(.{3,60}?)\s*[:—-]\s*(.+)$/);
      return m ? { q: m[1].trim(), a: m[2].trim() } : null;
    })
    .filter(Boolean)
    .slice(0, 12);
  return cards.length
    ? { ok: true, cards }
    : { ok: false, error: '📸 Cards nahi ban paye — brain ko bolo ya saaf photo do.' };
}

/** Full flow: buffer → OCR → cards → appended to pack. */
export async function scanToPack(buffer, pack, opts = {}) {
  const { ocr, makeCards, maxAdd = 12 } = opts;
  if (typeof ocr !== 'function') return { ok: false, error: '📸 OCR pipeline offline hai.' };
  let text;
  try {
    text = await ocr(buffer);
  } catch (err) {
    return { ok: false, error: `📸 OCR fail: ${err?.message ?? err}` };
  }
  const r = await cardsFromText(text, { makeCards });
  if (!r.ok) return r;
  const add = r.cards.slice(0, maxAdd);
  pack.flashcards.push(...add);
  return {
    ok: true,
    added: add.length,
    reply: `📸→🃏 *${add.length} cards add hue* "${pack.topic}" pack me.\nAbhi revise karo: \`/revise\``,
  };
}

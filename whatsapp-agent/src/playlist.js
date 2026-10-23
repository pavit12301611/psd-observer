// playlist.js — 📺 YouTube playlist → notes: har video ka transcript leke
// topic-wise summary + timestamps. `listVideos(playlistUrl)` and
// `transcript(videoUrl)` injected (prod: reach.js / yt channels).

export function parsePlaylistId(text) {
  const s = String(text ?? '');
  const m = s.match(/[?&]list=([\w-]{6,})/);
  return m ? m[1] : (/^(PL|OL)[\w-]{8,}$/.test(s.trim()) ? s.trim() : null);
}

/**
 * Build playlist notes from per-video transcripts.
 * videos = [{title, url, transcript}]
 */
export function playlistNotes(videos, opts = {}) {
  const { summarize } = opts;
  const list = (videos ?? []).filter((v) => v && (v.transcript || v.title));
  if (!list.length) return '📺 Playlist me koi video nahi mila.';
  const lines = list.map((v, i) => {
    const t = String(v.transcript ?? '').replace(/\s+/g, ' ').trim();
    const gist = t ? t.slice(0, 140) + (t.length > 140 ? '…' : '') : '(no transcript)';
    return `${i + 1}. *${v.title ?? v.url}* — ${gist}`;
  });
  const totalMin = list.reduce((s, v) => s + Math.round(String(v.transcript ?? '').split(/\s+/).length / 130), 0);
  const head = `📺 *Playlist notes* — ${list.length} videos (~${totalMin} min content)`;
  return `${head}\n${lines.join('\n')}\n\n_Poora summary chahiye? \`/yt summary\` bolo._`;
}

/** Aggregate summary prompt — caller runs it through the brain. */
export function summaryPrompt(videos) {
  const joined = (videos ?? [])
    .slice(0, 12)
    .map((v, i) => `VIDEO ${i + 1}: ${v.title}\n${String(v.transcript ?? '').slice(0, 800)}`)
    .join('\n\n');
  return `Make crisp notes from this YouTube playlist:\n- 3-5 bullet overall takeaways\n- per-video one-liner\n\n${joined}`;
}

/** Full pipeline helper with injected list+transcript fetchers. */
export async function buildPlaylistNotes(playlistRef, opts = {}) {
  const { listVideos, transcript, now = Date.now } = opts;
  if (typeof listVideos !== 'function') return '📺 YouTube channel offline hai (tools missing) — yt-dlp/ffmpeg check karo.';
  let videos;
  try {
    videos = await listVideos(playlistRef);
  } catch (err) {
    return `📺 Playlist nahi khul paya: ${err?.message ?? err}`;
  }
  const capped = (videos ?? []).slice(0, 15);
  if (typeof transcript === 'function') {
    for (const v of capped) {
      if (!v.transcript) {
        try { v.transcript = await transcript(v.url); } catch { /* skip */ }
      }
    }
  }
  void now;
  return playlistNotes(capped);
}

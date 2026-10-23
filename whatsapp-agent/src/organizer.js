// organizer.js — 🗂️ Download auto-organizer: Downloads folder ke files ko
// type ke hisaab se alag folders me. `/organize now [path]` ya focus/heartbeat
// ke saath auto. Moves (no deletes) — safe.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const RULES = [
  { folder: 'Images', re: /\.(jpe?g|png|gif|webp|bmp|svg)$/i },
  { folder: 'Videos', re: /\.(mp4|mkv|avi|mov|webm)$/i },
  { folder: 'Audio', re: /\.(mp3|wav|flac|ogg|m4a)$/i },
  { folder: 'Documents', re: /\.(pdf|docx?|xlsx?|pptx?|txt|md|csv)$/i },
  { folder: 'Archives', re: /\.(zip|rar|7z|tar|gz)$/i },
  { folder: 'Installers', re: /\.(deb|rpm|appimage|exe|msi|dmg)$/i },
  { folder: 'Code', re: /\.(js|py|json|html|css|sh|ts|java|c|cpp)$/i },
];

export function targetFor(filename) {
  const hit = RULES.find((r) => r.re.test(filename));
  return hit ? hit.folder : 'Others';
}

/** Organize one directory. Returns {moved, skipped, rows}. */
export function organize(dir, opts = {}) {
  const { dryRun = false, max = 200 } = opts;
  const root = path.resolve(dir ?? path.join(os.homedir(), 'Downloads'));
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { moved: 0, skipped: 0, rows: [], error: `🗂️ Folder nahi mili: ${root}` };
  }
  const rows = [];
  let moved = 0;
  let skipped = 0;
  for (const e of entries.slice(0, max)) {
    if (!e.isFile() || e.name.startsWith('.')) { skipped++; continue; }
    const folder = targetFor(e.name);
    const destDir = path.join(root, folder);
    const dest = path.join(destDir, e.name);
    rows.push(`${e.name} → ${folder}/`);
    if (!dryRun) {
      try {
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(path.join(root, e.name), dest);
        moved++;
      } catch { skipped++; }
    } else {
      moved++;
    }
  }
  return { moved, skipped, rows };
}

export function organizeReply(result) {
  if (result.error) return result.error;
  const head = `🗂️ *Organized* — ${result.moved} files sort hue`;
  return result.rows.length
    ? `${head}\n${result.rows.slice(0, 10).join('\n')}${result.rows.length > 10 ? `\n…+${result.rows.length - 10} more` : ''}`
    : `${head} (kuch nahi mila)`;
}

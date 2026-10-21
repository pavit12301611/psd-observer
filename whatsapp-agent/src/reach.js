// reach.js — Agent-Reach Internet & Platform Capability Router for PSD_Ai.
//
// Inspired by & adapted from Agent-Reach (github.com/Panniantong/Agent-Reach):
//   "Give your AI Agent eyes to see the entire internet — and deterministic
//    CLI/API channels instead of opening a browser and guessing clicks."
//
// Core principles:
//   1. Never open a GUI browser and blindly click coordinates to read a page,
//      search the web, get a YouTube transcript, inspect a GitHub repo, or
//      check Reddit / Twitter / HackerNews / RSS when a structured channel exists.
//   2. Multi-backend routing per platform (Tier 0 zero-config APIs/readers +
//      Tier 1/2 local CLIs like `yt-dlp`, `gh`, `opencli`, `mcporter`, `twitter`,
//      `rdt`, `bili`, plus Chrome CDP / local browser profile detection).
//   3. Side-effect-free `reachDoctor()` health check (`ok` / `warn` / `off` / `error`)
//      with active backend reporting and one-command setup hints.
//   4. Strict SSRF & credential-scrubbing safety boundaries.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 PSD_Ai-AgentReach/3.2';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const ANTIBOT_SCAN_CHARS = 4096;

export const OPENCLI_PACKAGE = '@jackwener/opencli';
export const OPENCLI_EXTENSION_ID = 'ildkmabpimmkaediidaifkhjpohdnifk';
export const OPENCLI_DAEMON_STATUS_URL = 'http://127.0.0.1:19825/status';
export const CDP_VERSION_URL = 'http://127.0.0.1:9222/json/version';

// ── Security & URL utilities (from agent_reach/utils/url.py & text.py) ────────

const PRIVATE_HOST_RE = /^(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|0\.0\.0\.0|\[?::1\]?|\[?fe80:[^\]]*\]?|\[?fc00:[^\]]*\]?|\[?fd[0-9a-f]{2}:[^\]]*\]?)$/i;

/** Scrub embedded credentials or tokens from URLs in diagnostic messages. */
export function scrubUrlCredentials(text) {
  return String(text ?? '')
    .replace(/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1***:***@')
    .replace(/([?&](?:api_key|apikey|token|access_token|auth_token|key)=)[^&\s]+/gi, '$1***');
}

/** Validate and normalize a public HTTP(S) URL; block loopback/private SSRF. */
export function normalizePublicHttpUrl(rawUrl) {
  let input = String(rawUrl ?? '').trim();
  if (!input) throw new Error('URL khali hai.');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    input = `https://${input}`;
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${scrubUrlCredentials(rawUrl)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http/https URLs are supported (got ${parsed.protocol})`);
  }
  if ( parsed.username || parsed.password) {
    throw new Error('URLs with embedded username/password are not allowed.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || PRIVATE_HOST_RE.test(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`Refusing private/local host "${host}" for external reader.`);
  }
  return parsed.toString();
}

/** Recognize high-confidence Jina/Cloudflare anti-bot challenge responses. */
export function isAntibotPage(bodyText) {
  const sample = String(bodyText ?? '').slice(0, ANTIBOT_SCAN_CHARS).toLowerCase();
  const jinaCaptcha = sample.includes('warning:') && sample.includes('requiring captcha');
  const challengeStructure = (
    sample.includes('title: just a moment...')
    || sample.includes('## performing security verification')
    || sample.includes('title: attention required! | cloudflare')
    || sample.includes('enable javascript and cookies to continue')
  );
  const cloudflareBlock = sample.includes('title: attention required! | cloudflare')
    && (sample.includes('ray id') || sample.includes('/cdn-cgi/challenge-platform/'));
  return (jinaCaptcha && challengeStructure) || cloudflareBlock;
}

// ── Clean HTML → Markdown converter (local zero-dep fallback) ────────────────

export function htmlToCleanMarkdown(html, sourceUrl = '') {
  const raw = String(html ?? '');
  if (!raw.trim()) return '';

  const decodeEntities = (s) => String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16) || 32));

  const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : '';

  // Prefer <article> or <main> when substantial, otherwise full <body>
  const articleMatch = raw.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
    || raw.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  let body = (articleMatch && articleMatch[1].length > 300) ? articleMatch[1] : raw;

  body = body
    .replace(/<(script|style|noscript|svg|iframe|canvas|nav|footer|header|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n\n#### $1\n\n')
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n• $1')
    .replace(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const cleanLabel = label.replace(/<[^>]+>/g, '').trim();
      if (!cleanLabel) return '';
      try {
        const resolved = sourceUrl ? new URL(href, sourceUrl).toString() : href;
        if (/^https?:\/\//i.test(resolved)) return `[${cleanLabel}](${resolved})`;
      } catch { /* ignore */ }
      return cleanLabel;
    })
    .replace(/<(?:p|div|section|article|blockquote|tr|br\s*\/?)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const cleaned = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, idx, arr) => line !== '' || (idx > 0 && arr[idx - 1] !== ''))
    .join('\n')
    .trim();

  return [
    title ? `# ${title}` : '',
    sourceUrl ? `URL: ${sourceUrl}` : '',
    '',
    cleaned,
  ].filter((x, i) => !(i < 2 && !x)).join('\n').trim();
}

// ── CLI & Backend Probing (from agent_reach/probe.py & backends/opencli.py) ──

/** Side-effect-free CLI probe. */
export async function probeCommand(bin, args = ['--version'], { timeoutMs = 5000, removeEnv = [] } = {}) {
  const env = { ...process.env };
  for (const k of removeEnv) delete env[k];
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
      env,
    });
    return {
      ok: true,
      status: 'ok',
      output: String(stdout || stderr || '').trim().slice(0, 400),
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, status: 'missing', output: '', hint: `${bin} not installed` };
    }
    return {
      ok: false,
      status: 'broken',
      output: String(err.stdout || err.stderr || err.message || '').trim().slice(0, 300),
      hint: err.message,
    };
  }
}

const CHROME_PROFILE_ROOTS = {
  chrome: ['~/.config/google-chrome', '~/Library/Application Support/Google/Chrome'],
  chromium: ['~/.config/chromium', '~/Library/Application Support/Chromium'],
  brave: ['~/.config/BraveSoftware/Brave-Browser', '~/Library/Application Support/BraveSoftware/Brave-Browser'],
  edge: ['~/.config/microsoft-edge', '~/Library/Application Support/Microsoft Edge'],
};

/** List local Chromium-family profiles that exist on disk (no cookie reading). */
export function listBrowserProfiles(browser = 'chrome') {
  const roots = CHROME_PROFILE_ROOTS[String(browser ?? 'chrome').toLowerCase()] ?? [];
  const profiles = [];
  for (const rawRoot of roots) {
    const root = rawRoot.startsWith('~/') ? path.join(os.homedir(), rawRoot.slice(2)) : rawRoot;
    if (!fs.existsSync(root)) continue;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pDir = path.join(root, entry.name);
        const hasCookies = fs.existsSync(path.join(pDir, 'Cookies')) || fs.existsSync(path.join(pDir, 'Network', 'Cookies'));
        const hasExt = fs.existsSync(path.join(pDir, 'Extensions', OPENCLI_EXTENSION_ID));
        if (hasCookies || entry.name === 'Default' || /^Profile \d+$/.test(entry.name)) {
          profiles.push({
            browser,
            profile: entry.name,
            path: pDir,
            hasCookies,
            hasOpenCliExtension: hasExt,
          });
        }
      }
    } catch { /* ignore */ }
  }
  return profiles;
}

/** Probe OpenCLI installation + loopback daemon status without starting the daemon. */
export async function probeOpenCli(timeoutMs = 2500) {
  const ver = await probeCommand('opencli', ['--version'], {
    timeoutMs,
    removeEnv: ['OPENCLI_DAEMON_PORT'],
  });
  const allProfiles = ['chrome', 'chromium', 'brave', 'edge'].flatMap((b) => listBrowserProfiles(b));
  const extensionOnDisk = allProfiles.some((p) => p.hasOpenCliExtension);
  const unpackedPresent = fs.existsSync(path.join(os.homedir(), '.opencli', 'extension', 'manifest.json'));

  if (!ver.ok) {
    return {
      installed: ver.status !== 'missing',
      broken: ver.status === 'broken',
      daemonRunning: false,
      extensionConnected: false,
      extensionInstalled: extensionOnDisk,
      unpackedPresent,
      ready: false,
      version: '',
      hint: `Install OpenCLI for browser-session reuse: npm install -g ${OPENCLI_PACKAGE}`,
    };
  }

  let daemonRunning = false;
  let extensionConnected = false;
  try {
    const res = await fetch(OPENCLI_DAEMON_STATUS_URL, {
      headers: { 'X-OpenCLI': '1' },
      signal: AbortSignal.timeout(Math.min(timeoutMs, 1500)),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok === true) {
        daemonRunning = true;
        extensionConnected = Boolean(data.extensionConnected);
      }
    }
  } catch { /* daemon not running */ }

  const ready = ver.ok && extensionConnected;
  return {
    installed: true,
    broken: false,
    daemonRunning,
    extensionConnected,
    extensionInstalled: extensionOnDisk,
    unpackedPresent,
    ready,
    version: ver.output.split('\n')[0] || 'installed',
    hint: ready
      ? `OpenCLI active (v${ver.output.split('\n')[0]})`
      : 'OpenCLI installed; load/enable the OpenCLI Chrome extension to reuse live browser sessions.',
  };
}

/** Probe whether a browser is listening on Chrome DevTools Protocol (127.0.0.1:9222). */
export async function probeBrowserCdp(timeoutMs = 1500) {
  try {
    const res = await fetch(CDP_VERSION_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { active: false };
    const data = await res.json();
    return {
      active: Boolean(data?.Browser || data?.webSocketDebuggerUrl),
      browser: data?.Browser || 'Chromium',
      wsUrl: data?.webSocketDebuggerUrl || '',
    };
  } catch {
    return { active: false };
  }
}

// ── Platform Detection & URL Routing ─────────────────────────────────────────

export function detectPlatform(input) {
  const s = String(input ?? '').trim();
  if (!s) return 'search';
  try {
    const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host === 'music.youtube.com') return 'youtube';
    if (host === 'github.com' || host === 'gist.github.com' || host === 'raw.githubusercontent.com') return 'github';
    if (host === 'reddit.com' || host === 'old.reddit.com' || host === 'redd.it') return 'reddit';
    if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com' || host === 'fxtwitter.com' || host === 'vxtwitter.com') return 'twitter';
    if (host === 'news.ycombinator.com') return 'hackernews';
    if (host === 'v2ex.com') return 'v2ex';
    if (host === 'stackoverflow.com' || host.endsWith('.stackexchange.com')) return 'stackoverflow';
    if (host === 'bilibili.com' || host === 'b23.tv') return 'bilibili';
    if (host === 'xiaohongshu.com' || host === 'xhslink.com') return 'xiaohongshu';
    if (host === 'linkedin.com') return 'linkedin';
    if (host === 'instagram.com') return 'instagram';
    if (host === 'facebook.com' || host === 'fb.com') return 'facebook';
    if (host === 'xueqiu.com') return 'xueqiu';
    if (/\.(?:rss|xml|atom)$/i.test(url.pathname) || /\/(?:feed|rss|atom)\/?$/i.test(url.pathname)) return 'rss';
    if (/^https?:\/\//i.test(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(s)) return 'web';
  } catch { /* plain query */ }
  return 'search';
}

// ── Channel 1: Universal Web Reader (Jina Reader + Local Clean Markdown) ────

export async function readWebUrl(rawUrl, { timeoutMs = 20_000, maxChars = 6000, fetchImpl = fetch } = {}) {
  const url = normalizePublicHttpUrl(rawUrl);

  // Backend 1: Jina Reader (https://r.jina.ai/URL) — Agent-Reach Tier 0 primary
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetchImpl(jinaUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/plain, text/markdown;q=0.9, */*;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const text = await res.text();
      if (text && text.trim().length > 40 && !isAntibotPage(text)) {
        return {
          ok: true,
          platform: 'web',
          backend: 'Jina Reader',
          url,
          content: text.trim().slice(0, maxChars),
        };
      }
    }
  } catch { /* fall through to direct fetch */ }

  // Backend 2: Direct HTTP fetch + local HTML-to-Markdown parser
  try {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, platform: 'web', backend: 'direct', url, error: `HTTP ${res.status}` };
    }
    const contentType = String(res.headers?.get?.('content-type') ?? '').toLowerCase();
    const rawBody = await res.text();
    if (isAntibotPage(rawBody)) {
      return {
        ok: false,
        platform: 'web',
        backend: 'direct',
        url,
        error: 'Target site returned an anti-bot/Cloudflare challenge page. Use a logged-in browser session or OpenCLI.',
      };
    }
    const content = contentType.includes('json')
      ? rawBody.slice(0, maxChars)
      : htmlToCleanMarkdown(rawBody, url).slice(0, maxChars);
    return {
      ok: Boolean(content.trim()),
      platform: 'web',
      backend: 'Local Markdown Extractor',
      url,
      content: content || '(empty page)',
    };
  } catch (err) {
    return {
      ok: false,
      platform: 'web',
      backend: 'direct',
      url,
      error: scrubUrlCredentials(err.message),
    };
  }
}

// ── Channel 2: Multi-Backend Web Search (Exa MCP → DuckDuckGo → Wiki/HN) ─────

export function parseDuckDuckGoHtml(html, limit = 8) {
  const results = [];
  const raw = String(html ?? '');
  const decode = (s) => String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const unwrapDdgUrl = (href) => {
    try {
      if (href.includes('uddg=')) {
        const u = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://html.duckduckgo.com');
        const uddg = u.searchParams.get('uddg');
        if (uddg) return decodeURIComponent(uddg);
      }
    } catch { /* ignore */ }
    return href.startsWith('//') ? `https:${href}` : href;
  };

  const blockRe = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]{0,1200}?(?:<a[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>|<div[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>)?/gi;
  let m;
  while ((m = blockRe.exec(raw)) && results.length < limit) {
    const url = unwrapDdgUrl(m[1]);
    const title = decode(m[2]);
    const snippet = decode(m[3] || m[4] || '');
    if (title && /^https?:\/\//i.test(url) && !url.includes('duckduckgo.com/y.js')) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

export async function webSearch(query, { limit = 6, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('Search query khali hai.');
  const max = Math.min(Math.max(Number(limit) || 6, 1), 15);

  // Backend 1: Exa MCP via `mcporter` if installed (Agent-Reach primary search)
  try {
    const { stdout } = await execFileAsync(
      'mcporter',
      ['call', 'exa.web_search_exa', `query=${q}`, `numResults=${max}`],
      { timeout: Math.min(timeoutMs, 10_000), maxBuffer: 2 * 1024 * 1024 },
    );
    if (stdout && stdout.trim().length > 30) {
      return {
        ok: true,
        platform: 'search',
        backend: 'Exa MCP (mcporter)',
        query: q,
        results: [],
        text: `🔎 *Web Search (${q})* — _via Exa AI Search_\n\n${stdout.trim().slice(0, 4000)}`,
      };
    }
  } catch { /* mcporter not installed or unavailable — fall through */ }

  // Backend 2: DuckDuckGo HTML endpoint
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const res = await fetchImpl(ddgUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const html = await res.text();
      const items = parseDuckDuckGoHtml(html, max);
      if (items.length > 0) {
        const formatted = items.map((r, i) => (
          `${i + 1}. *${r.title}*\n   🔗 ${r.url}${r.snippet ? `\n   _${r.snippet.slice(0, 220)}_` : ''}`
        )).join('\n\n');
        return {
          ok: true,
          platform: 'search',
          backend: 'DuckDuckGo HTML',
          query: q,
          results: items,
          text: `🔎 *Web Search: "${q}"* _(${items.length} results · Agent-Reach)_\n\n${formatted}`,
        };
      }
    }
  } catch { /* fall through */ }

  // Backend 3: Parallel Wikipedia + HackerNews Algolia + GitHub API (100% reliable JSON APIs)
  const [wikiRes, hnRes] = await Promise.allSettled([
    fetchImpl(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&utf8=&format=json&srlimit=${Math.min(max, 4)}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8000),
    }).then((r) => (r.ok ? r.json() : null)),
    fetchImpl(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=${Math.min(max, 4)}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8000),
    }).then((r) => (r.ok ? r.json() : null)),
  ]);

  const combined = [];
  if (wikiRes.status === 'fulfilled' && wikiRes.value?.query?.search) {
    for (const s of wikiRes.value.query.search) {
      const snippet = String(s.snippet ?? '').replace(/<[^>]+>/g, '').trim();
      combined.push({
        title: `[Wikipedia] ${s.title}`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
        snippet,
      });
    }
  }
  if (hnRes.status === 'fulfilled' && hnRes.value?.hits) {
    for (const h of hnRes.value.hits) {
      if (!h.title) continue;
      combined.push({
        title: `[HN] ${h.title}`,
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        snippet: `${h.points ?? 0} pts · ${h.num_comments ?? 0} comments`,
      });
    }
  }

  if (combined.length > 0) {
    const items = combined.slice(0, max);
    const formatted = items.map((r, i) => (
      `${i + 1}. *${r.title}*\n   🔗 ${r.url}${r.snippet ? `\n   _${r.snippet.slice(0, 200)}_` : ''}`
    )).join('\n\n');
    return {
      ok: true,
      platform: 'search',
      backend: 'Wikipedia + HN Algolia API',
      query: q,
      results: items,
      text: `🔎 *Web Search: "${q}"* _(${items.length} results · Agent-Reach)_\n\n${formatted}`,
    };
  }

  return {
    ok: false,
    platform: 'search',
    backend: 'none',
    query: q,
    results: [],
    text: `⚠️ "${q}" ke liye search results nahi mile (network ya search backend unreachable).`,
  };
}

// ── Channel 3: YouTube (yt-dlp metadata, search, VTT subtitles + direct play) ─

/** Parse WebVTT subtitles into clean, deduplicated plain text (removes rolling duplicates). */
export function parseVttTranscript(vttText) {
  const lines = String(vttText ?? '').split(/\r?\n/);
  const out = [];
  let prev = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(?:WEBVTT|Kind:|Language:|NOTE\b|STYLE\b)/i.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d{2}:\d{2}[:.]\d{2}/.test(line) || line.includes('-->')) continue;
    const clean = line
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean || clean === prev) continue;
    if (prev && clean.startsWith(prev)) {
      out[out.length - 1] = clean;
    } else if (!prev || !prev.includes(clean)) {
      out.push(clean);
    }
    prev = clean;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Extract YouTube video ID from any youtube.com / youtu.be URL. */
export function extractYoutubeId(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/(?:youtube\.com\/(?:watch\?.*?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return null;
}

/** Search YouTube deterministically via `yt-dlp` or direct YouTube `ytInitialData` JSON. */
export async function youtubeSearch(query, { limit = 5, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('YouTube search query khali hai.');
  const max = Math.min(Math.max(Number(limit) || 5, 1), 10);

  // Backend 1: yt-dlp (Agent-Reach primary)
  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      ['--dump-json', '--flat-playlist', '--no-warnings', `ytsearch${max}:${q}`],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );
    const items = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const d = JSON.parse(line);
          const id = d.id || extractYoutubeId(d.url);
          return id ? {
            id,
            title: d.title || 'YouTube Video',
            url: `https://www.youtube.com/watch?v=${id}`,
            channel: d.uploader || d.channel || '',
            duration: d.duration_string || (d.duration ? `${Math.floor(d.duration / 60)}:${String(d.duration % 60).padStart(2, '0')}` : ''),
            views: d.view_count ?? null,
          } : null;
        } catch { return null; }
      })
      .filter(Boolean);
    if (items.length > 0) {
      return { ok: true, backend: 'yt-dlp', query: q, videos: items };
    }
  } catch { /* fall through to HTTPS scrape */ }

  // Backend 2: Zero-config HTTPS YouTube search results JSON (`ytInitialData`)
  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en`;
    const res = await fetchImpl(searchUrl, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const html = await res.text();
      const videos = [];
      const seen = new Set();
      const re = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,1500}?"title":\{"runs":\[\{"text":"([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) && videos.length < max) {
        const [, id, rawTitle] = m;
        if (seen.has(id)) continue;
        seen.add(id);
        videos.push({
          id,
          title: rawTitle.replace(/\\u0026/g, '&').replace(/\\"/g, '"'),
          url: `https://www.youtube.com/watch?v=${id}`,
          channel: '',
          duration: '',
        });
      }
      if (videos.length > 0) {
        return { ok: true, backend: 'YouTube Web JSON', query: q, videos };
      }
    }
  } catch { /* ignore */ }

  return { ok: false, backend: 'none', query: q, videos: [] };
}

/** Extract YouTube video metadata + subtitles/transcript (Agent-Reach retry chain). */
export async function youtubeTranscript(urlOrId, { lang = 'en,hi', timeoutMs = 25_000, fetchImpl = fetch } = {}) {
  const id = extractYoutubeId(urlOrId);
  const url = id ? `https://www.youtube.com/watch?v=${id}` : normalizePublicHttpUrl(urlOrId);
  const videoId = id || extractYoutubeId(url) || `yt_${Date.now()}`;

  let meta = null;
  // Step 1: yt-dlp metadata + subtitle extraction
  const tmpPrefix = path.join(os.tmpdir(), `psd_yt_${videoId}_${Date.now()}`);
  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      [
        '--write-sub',
        '--write-auto-sub',
        '--sub-lang', `${lang},en-US,en-GB,en.*`,
        '--sub-format', 'vtt',
        '--skip-download',
        '--print-json',
        '--no-warnings',
        '-o', tmpPrefix,
        url,
      ],
      { timeout: timeoutMs, maxBuffer: 6 * 1024 * 1024 },
    );
    const firstLine = stdout.trim().split('\n')[0];
    if (firstLine) {
      try {
        const d = JSON.parse(firstLine);
        meta = {
          id: d.id || videoId,
          title: d.title || '',
          channel: d.uploader || d.channel || '',
          duration: d.duration_string || (d.duration ? `${Math.round(d.duration / 60)}m` : ''),
          views: d.view_count ?? null,
          description: String(d.description ?? '').slice(0, 600),
          url: d.webpage_url || url,
        };
      } catch { /* ignore */ }
    }

    const dir = path.dirname(tmpPrefix);
    const base = path.basename(tmpPrefix);
    const vttFiles = fs.readdirSync(dir).filter((f) => f.startsWith(base) && f.endsWith('.vtt'));
    if (vttFiles.length > 0) {
      const vttPath = path.join(dir, vttFiles[0]);
      const rawVtt = fs.readFileSync(vttPath, 'utf8');
      for (const f of vttFiles) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
      const transcript = parseVttTranscript(rawVtt);
      if (transcript.length > 10) {
        return {
          ok: true,
          platform: 'youtube',
          backend: 'yt-dlp',
          url,
          meta,
          transcript,
        };
      }
    }
  } catch {
    // Clean up any partial temp files
    try {
      const dir = path.dirname(tmpPrefix);
      const base = path.basename(tmpPrefix);
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(base)) fs.unlinkSync(path.join(dir, f));
      }
    } catch { /* ignore */ }
  }

  // Step 2: OpenCLI fallback (`opencli youtube transcript URL -f yaml`) per Agent-Reach video.md
  try {
    const { stdout } = await execFileAsync(
      'opencli',
      ['youtube', 'transcript', url, '-f', 'yaml'],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
    );
    if (stdout && stdout.trim().length > 20 && !stdout.includes('Caption URL returned empty response')) {
      return {
        ok: true,
        platform: 'youtube',
        backend: 'OpenCLI',
        url,
        meta,
        transcript: stdout.trim(),
      };
    }
  } catch { /* fall through */ }

  // Step 3: Direct YouTube watch page `captionTracks` + metadata extractor
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const html = await res.text();
      if (!meta) {
        const titleM = html.match(/<title>([\s\S]*?)<\/title>/i);
        const ownerM = html.match(/"ownerChannelName":"([^"]+)"/);
        const shortDescM = html.match(/"shortDescription":"((?:\\.|[^"\\])*)"/);
        meta = {
          id: videoId,
          title: titleM ? titleM[1].replace(/\s*-\s*YouTube$/i, '').trim() : 'YouTube Video',
          channel: ownerM ? ownerM[1] : '',
          description: shortDescM ? shortDescM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').slice(0, 600) : '',
          url,
        };
      }
      const tracksM = html.match(/"captionTracks":(\[[\s\S]*?\])/);
      if (tracksM) {
        const tracks = JSON.parse(tracksM[1]);
        const chosen = tracks.find((t) => /^en/i.test(t.languageCode))
          || tracks.find((t) => /^hi/i.test(t.languageCode))
          || tracks[0];
        if (chosen?.baseUrl) {
          const subUrl = `${chosen.baseUrl.replace(/\\u0026/g, '&')}&fmt=vtt`;
          const subRes = await fetchImpl(subUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(10_000),
          });
          if (subRes.ok) {
            const rawSub = await subRes.text();
            const transcript = rawSub.includes('WEBVTT')
              ? parseVttTranscript(rawSub)
              : rawSub.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (transcript.length > 10) {
              return {
                ok: true,
                platform: 'youtube',
                backend: 'YouTube CaptionTracks API',
                url,
                meta,
                transcript,
              };
            }
          }
        }
      }
    }
  } catch { /* ignore */ }

  if (meta) {
    return {
      ok: true,
      platform: 'youtube',
      backend: 'yt-dlp metadata (no captions on video)',
      url,
      meta,
      transcript: '',
    };
  }
  return {
    ok: false,
    platform: 'youtube',
    backend: 'none',
    url,
    error: 'Could not extract YouTube video details or subtitles.',
  };
}

// ── Channel 4: GitHub (gh CLI + Zero-Config REST API fallback) ───────────────

export async function githubLookup(queryOrRepo, { mode = 'auto', limit = 6, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const raw = String(queryOrRepo ?? '').trim();
  if (!raw) throw new Error('GitHub query ya owner/repo do.');
  const max = Math.min(Math.max(Number(limit) || 6, 1), 15);

  // Extract owner/repo if a GitHub URL or `owner/repo` slug was passed
  const urlMatch = raw.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/(issues|pull|blob|tree)\/([^\s?#]+))?/i);
  const slugMatch = !urlMatch && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) ? [null, raw] : null;
  const repoSlug = (urlMatch?.[1] || slugMatch?.[1] || '').replace(/\.git$/i, '');
  const subKind = urlMatch?.[2]?.toLowerCase() || '';
  const subRef = urlMatch?.[3] || '';

  const effectiveMode = mode !== 'auto'
    ? mode
    : subKind === 'issues' ? 'issue'
    : subKind === 'pull' ? 'pr'
    : repoSlug ? 'repo'
    : 'search';

  // Backend 1: `gh` CLI when available
  try {
    if (effectiveMode === 'repo' && repoSlug) {
      const { stdout } = await execFileAsync(
        'gh',
        ['repo', 'view', repoSlug, '--json', 'nameWithOwner,description,stargazerCount,forkCount,url,defaultBranchRef,latestRelease,readme'],
        { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      );
      const d = JSON.parse(stdout);
      const readme = String(d.readme ?? '').slice(0, 2500);
      return {
        ok: true,
        platform: 'github',
        backend: 'gh CLI',
        text: [
          `🐙 *${d.nameWithOwner}* ⭐ ${d.stargazerCount ?? 0} · 🍴 ${d.forkCount ?? 0}`,
          d.description ? `_${d.description}_` : '',
          `🔗 ${d.url}`,
          readme ? `\n*README excerpt:*\n${readme}` : '',
        ].filter(Boolean).join('\n'),
        data: d,
      };
    }
    if (effectiveMode === 'search') {
      const { stdout } = await execFileAsync(
        'gh',
        ['search', 'repos', raw, '--sort', 'stars', '--limit', String(max), '--json', 'fullName,description,stargazersCount,url,language'],
        { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 },
      );
      const items = JSON.parse(stdout);
      if (Array.isArray(items) && items.length > 0) {
        const lines = items.map((r, i) => (
          `${i + 1}. *${r.fullName}* ⭐ ${r.stargazersCount ?? 0}${r.language ? ` · ${r.language}` : ''}\n   🔗 ${r.url}${r.description ? `\n   _${r.description.slice(0, 160)}_` : ''}`
        ));
        return {
          ok: true,
          platform: 'github',
          backend: 'gh CLI',
          results: items,
          text: `🐙 *GitHub Repos: "${raw}"* _(via gh CLI)_\n\n${lines.join('\n\n')}`,
        };
      }
    }
  } catch { /* fall through to GitHub REST API */ }

  // Backend 2: Zero-config GitHub REST API
  const ghHeaders = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
    ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN || process.env.GH_TOKEN}`;
  }

  try {
    if ((effectiveMode === 'issue' || effectiveMode === 'pr') && repoSlug && /^\d+$/.test(subRef)) {
      const apiUrl = `https://api.github.com/repos/${repoSlug}/issues/${subRef}`;
      const res = await fetchImpl(apiUrl, { headers: ghHeaders, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const d = await res.json();
        return {
          ok: true,
          platform: 'github',
          backend: 'GitHub REST API',
          data: d,
          text: [
            `🐙 *${repoSlug}#${d.number}: ${d.title}* [${d.state}]`,
            `👤 @${d.user?.login ?? 'unknown'} · 💬 ${d.comments ?? 0} comments`,
            `🔗 ${d.html_url}`,
            '',
            String(d.body ?? '(no description)').slice(0, 2500),
          ].join('\n'),
        };
      }
    }

    if (effectiveMode === 'repo' && repoSlug) {
      const [repoRes, readmeRes] = await Promise.allSettled([
        fetchImpl(`https://api.github.com/repos/${repoSlug}`, { headers: ghHeaders, signal: AbortSignal.timeout(timeoutMs) }),
        fetchImpl(`https://api.github.com/repos/${repoSlug}/readme`, {
          headers: { ...ghHeaders, Accept: 'application/vnd.github.raw+json' },
          signal: AbortSignal.timeout(timeoutMs),
        }),
      ]);
      if (repoRes.status === 'fulfilled' && repoRes.value.ok) {
        const d = await repoRes.value.json();
        const readme = readmeRes.status === 'fulfilled' && readmeRes.value.ok
          ? (await readmeRes.value.text()).slice(0, 2500)
          : '';
        return {
          ok: true,
          platform: 'github',
          backend: 'GitHub REST API',
          data: d,
          text: [
            `🐙 *${d.full_name}* ⭐ ${d.stargazers_count ?? 0} · 🍴 ${d.forks_count ?? 0}${d.language ? ` · ${d.language}` : ''}`,
            d.description ? `_${d.description}_` : '',
            `🔗 ${d.html_url}`,
            readme ? `\n*README excerpt:*\n${readme}` : '',
          ].filter(Boolean).join('\n'),
        };
      }
    }

    // Default: search repositories
    const searchUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(raw)}&sort=stars&order=desc&per_page=${max}`;
    const res = await fetchImpl(searchUrl, { headers: ghHeaders, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const data = await res.json();
      const items = (data.items ?? []).slice(0, max);
      const lines = items.map((r, i) => (
        `${i + 1}. *${r.full_name}* ⭐ ${r.stargazers_count ?? 0}${r.language ? ` · ${r.language}` : ''}\n   🔗 ${r.html_url}${r.description ? `\n   _${String(r.description).slice(0, 160)}_` : ''}`
      ));
      return {
        ok: true,
        platform: 'github',
        backend: 'GitHub REST API',
        results: items,
        text: items.length
          ? `🐙 *GitHub Repos: "${raw}"* _(${items.length} results)_\n\n${lines.join('\n\n')}`
          : `🐙 GitHub pe "${raw}" ke liye koi repo nahi mila.`,
      };
    }
  } catch (err) {
    return { ok: false, platform: 'github', backend: 'GitHub REST API', error: scrubUrlCredentials(err.message) };
  }

  return { ok: false, platform: 'github', backend: 'none', error: 'GitHub lookup failed.' };
}

// ── Channel 5: Reddit (OpenCLI → rdt-cli → Reddit JSON/PullPush fallback) ────

export async function redditLookup(queryOrUrl, { limit = 6, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const q = String(queryOrUrl ?? '').trim();
  if (!q) throw new Error('Reddit query ya URL do.');
  const max = Math.min(Math.max(Number(limit) || 6, 1), 15);
  const isUrl = /^https?:\/\/(?:www\.|old\.)?reddit\.com\//i.test(q);

  // Backend 1: OpenCLI (`opencli reddit search/read -f yaml`)
  try {
    const args = isUrl
      ? ['reddit', 'read', q, '-f', 'yaml']
      : ['reddit', 'search', q, '-f', 'yaml'];
    const { stdout } = await execFileAsync('opencli', args, { timeout: 12_000, maxBuffer: 2 * 1024 * 1024 });
    if (stdout && stdout.trim().length > 20) {
      return {
        ok: true,
        platform: 'reddit',
        backend: 'OpenCLI',
        text: `👽 *Reddit (${q})* — _via OpenCLI_\n\n${stdout.trim().slice(0, 3500)}`,
      };
    }
  } catch { /* fall through */ }

  // Backend 2: `rdt` CLI
  try {
    const args = isUrl ? ['read', q] : ['search', q, '--limit', String(max)];
    const { stdout } = await execFileAsync('rdt', args, { timeout: 12_000, maxBuffer: 2 * 1024 * 1024 });
    if (stdout && stdout.trim().length > 20) {
      return {
        ok: true,
        platform: 'reddit',
        backend: 'rdt-cli',
        text: `👽 *Reddit (${q})* — _via rdt-cli_\n\n${stdout.trim().slice(0, 3500)}`,
      };
    }
  } catch { /* fall through */ }

  // Backend 3: Reddit JSON endpoint / PullPush archive
  try {
    const apiUrl = isUrl
      ? `${q.replace(/\/?(\?.*)?$/, '')}.json?limit=10`
      : `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=relevance&limit=${max}`;
    const res = await fetchImpl(apiUrl, {
      headers: { 'User-Agent': 'linux:psd-ai-agent-reach:v3.2.0 (by /u/psd_ai)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data[0]?.data?.children?.[0]?.data) {
        const post = data[0].data.children[0].data;
        const comments = (data[1]?.data?.children ?? [])
          .map((c) => c.data)
          .filter((c) => c?.body && c.author !== 'AutoModerator')
          .slice(0, 6)
          .map((c, i) => `${i + 1}. *@${c.author}* (⬆️ ${c.score ?? 0}): ${String(c.body).replace(/\s+/g, ' ').slice(0, 260)}`);
        return {
          ok: true,
          platform: 'reddit',
          backend: 'Reddit JSON',
          text: [
            `👽 *r/${post.subreddit}: ${post.title}* (⬆️ ${post.score ?? 0} · 💬 ${post.num_comments ?? 0})`,
            `🔗 https://www.reddit.com${post.permalink}`,
            post.selftext ? `\n${String(post.selftext).slice(0, 1500)}` : '',
            comments.length ? `\n*Top Comments:*\n${comments.join('\n')}` : '',
          ].filter(Boolean).join('\n'),
        };
      }
      const children = data?.data?.children ?? [];
      if (children.length > 0) {
        const lines = children.slice(0, max).map(({ data: p }, i) => (
          `${i + 1}. *[r/${p.subreddit}] ${p.title}* (⬆️ ${p.score ?? 0} · 💬 ${p.num_comments ?? 0})\n   🔗 https://www.reddit.com${p.permalink}`
        ));
        return {
          ok: true,
          platform: 'reddit',
          backend: 'Reddit JSON',
          text: `👽 *Reddit Search: "${q}"*\n\n${lines.join('\n\n')}`,
        };
      }
    }
  } catch { /* fall through */ }

  // Backend 4: PullPush Reddit search API (zero-auth public mirror)
  if (!isUrl) {
    try {
      const ppUrl = `https://api.pullpush.io/reddit/search/submission/?q=${encodeURIComponent(q)}&size=${max}&sort=desc`;
      const res = await fetchImpl(ppUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        const items = data?.data ?? [];
        if (items.length > 0) {
          const lines = items.slice(0, max).map((p, i) => (
            `${i + 1}. *[r/${p.subreddit}] ${p.title}* (⬆️ ${p.score ?? 0})\n   🔗 https://www.reddit.com${p.permalink || `/comments/${p.id}`}`
          ));
          return {
            ok: true,
            platform: 'reddit',
            backend: 'PullPush Archive API',
            text: `👽 *Reddit Search: "${q}"*\n\n${lines.join('\n\n')}`,
          };
        }
      }
    } catch { /* ignore */ }
  }

  return isUrl
    ? readWebUrl(q, { timeoutMs, fetchImpl })
    : { ok: false, platform: 'reddit', backend: 'none', text: `⚠️ Reddit search "${q}" requires login session (install OpenCLI or rdt-cli).` };
}

// ── Channel 6: Twitter / X (twitter-cli → OpenCLI → FxTwitter JSON API) ──────

export async function twitterLookup(queryOrUrl, { limit = 8, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const q = String(queryOrUrl ?? '').trim();
  if (!q) throw new Error('Twitter/X query ya URL do.');

  const tweetMatch = q.match(/(?:x\.com|twitter\.com|fxtwitter\.com|vxtwitter\.com)\/([A-Za-z0-9_]+)\/status\/(\d+)/i);

  // Zero-config fast path for any single Tweet URL: FxTwitter JSON API!
  if (tweetMatch) {
    const [, user, statusId] = tweetMatch;
    try {
      const apiUrl = `https://api.fxtwitter.com/${user}/status/${statusId}`;
      const res = await fetchImpl(apiUrl, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const data = await res.json();
        const t = data?.tweet;
        if (t) {
          return {
            ok: true,
            platform: 'twitter',
            backend: 'FxTwitter API',
            data: t,
            text: [
              `🐦 *${t.author?.name || user}* (@${t.author?.screen_name || user})`,
              t.text || '',
              `❤️ ${t.likes ?? 0} · 🔁 ${t.retweets ?? 0} · 💬 ${t.replies ?? 0} · 👁️ ${t.views ?? 0}`,
              `🔗 https://x.com/${user}/status/${statusId}`,
            ].filter(Boolean).join('\n\n'),
          };
        }
      }
    } catch { /* fall through */ }
  }

  // Backend 1: `twitter-cli` (`twitter search` / `twitter tweet` / `twitter user-posts`)
  try {
    const args = tweetMatch
      ? ['tweet', q]
      : /^@[A-Za-z0-9_]+$/.test(q)
      ? ['user-posts', q, '-n', String(limit)]
      : ['search', q, '-n', String(limit)];
    const { stdout } = await execFileAsync('twitter', args, { timeout: 12_000, maxBuffer: 2 * 1024 * 1024 });
    if (stdout && stdout.trim().length > 15) {
      return {
        ok: true,
        platform: 'twitter',
        backend: 'twitter-cli',
        text: `🐦 *Twitter/X (${q})* — _via twitter-cli_\n\n${stdout.trim().slice(0, 3500)}`,
      };
    }
  } catch { /* fall through */ }

  // Backend 2: OpenCLI (`opencli twitter search/article/user-posts -f yaml`)
  try {
    const args = tweetMatch
      ? ['twitter', 'article', q, '-f', 'yaml']
      : ['twitter', 'search', q, '-f', 'yaml'];
    const { stdout } = await execFileAsync('opencli', args, { timeout: 12_000, maxBuffer: 2 * 1024 * 1024 });
    if (stdout && stdout.trim().length > 15) {
      return {
        ok: true,
        platform: 'twitter',
        backend: 'OpenCLI',
        text: `🐦 *Twitter/X (${q})* — _via OpenCLI_\n\n${stdout.trim().slice(0, 3500)}`,
      };
    }
  } catch { /* fall through */ }

  if (/^https?:\/\//i.test(q)) {
    return readWebUrl(q, { timeoutMs, fetchImpl });
  }
  return {
    ok: false,
    platform: 'twitter',
    backend: 'none',
    text: `⚠️ Twitter/X search "${q}" ke liye \`twitter-cli\` ya \`opencli\` Chrome extension chahiye (Tweet URLs bina config ke seedha padhe ja sakte hain).`,
  };
}

// ── Channel 7: HackerNews, V2EX, StackOverflow & RSS (Tier 0 Zero-Config) ────

export async function hackerNewsLookup(query = '', { limit = 8, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const q = String(query ?? '').trim();
  const max = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const url = q
    ? `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=${max}`
    : `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${max}`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HN API HTTP ${res.status}`);
  const data = await res.json();
  const hits = (data?.hits ?? []).slice(0, max);
  const lines = hits.map((h, i) => (
    `${i + 1}. *${h.title || h.story_title || 'HN Post'}* (${h.points ?? 0} pts · 💬 ${h.num_comments ?? 0})\n   🔗 ${h.url || `https://news.ycombinator.com/item?id=${h.objectID}`}`
  ));
  return {
    ok: true,
    platform: 'hackernews',
    backend: 'HN Algolia API',
    results: hits,
    text: `🟧 *Hacker News ${q ? `("${q}")` : '(Top Stories)'}*\n\n${lines.join('\n\n') || '(no stories)'}`,
  };
}

export async function v2exLookup(nodeOrQuery = '', { limit = 8, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const q = String(nodeOrQuery ?? '').trim();
  const max = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const topicMatch = q.match(/v2ex\.com\/t\/(\d+)/i) || (/^\d+$/.test(q) ? [null, q] : null);
  const url = topicMatch
    ? `https://www.v2ex.com/api/topics/show.json?id=${topicMatch[1]}`
    : q && /^[a-z0-9_-]+$/i.test(q) && q.toLowerCase() !== 'hot'
    ? `https://www.v2ex.com/api/topics/show.json?node_name=${encodeURIComponent(q.toLowerCase())}`
    : 'https://www.v2ex.com/api/topics/hot.json';
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'agent-reach/1.0' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`V2EX API HTTP ${res.status}`);
  const items = await res.json();
  const list = (Array.isArray(items) ? items : []).slice(0, max);
  const lines = list.map((t, i) => (
    `${i + 1}. *[${t.node?.title || t.node?.name || 'V2EX'}] ${t.title}* (💬 ${t.replies ?? 0})\n   🔗 ${t.url}`
  ));
  return {
    ok: true,
    platform: 'v2ex',
    backend: 'V2EX Public API',
    results: list,
    text: `💬 *V2EX ${q || 'Hot Topics'}*\n\n${lines.join('\n\n') || '(no topics)'}`,
  };
}

export async function stackOverflowLookup(query, { limit = 5, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('StackOverflow query khali hai.');
  const max = Math.min(Math.max(Number(limit) || 5, 1), 10);
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=stackoverflow&pagesize=${max}`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`StackExchange HTTP ${res.status}`);
  const data = await res.json();
  const items = (data?.items ?? []).slice(0, max);
  const lines = items.map((it, i) => (
    `${i + 1}. *${it.title}* (${it.is_answered ? '✅ Answered' : '⏳ Open'} · ⬆️ ${it.score ?? 0} · ${it.answer_count ?? 0} answers)\n   🔗 ${it.link}`
  ));
  return {
    ok: true,
    platform: 'stackoverflow',
    backend: 'StackExchange API',
    results: items,
    text: `📚 *StackOverflow: "${q}"*\n\n${lines.join('\n\n') || '(no matches)'}`,
  };
}

export function parseRssXml(xmlText, limit = 8) {
  const raw = String(xmlText ?? '');
  const entries = [];
  const decode = (s) => String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const blocks = raw.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  for (const b of blocks.slice(0, limit)) {
    const title = decode(b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const linkHref = b.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1]
      || decode(b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? '');
    const summary = decode(
      b.match(/<(?:description|summary|content:encoded|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content:encoded|content)>/i)?.[1] ?? '',
    ).slice(0, 220);
    if (title || linkHref) entries.push({ title: title || linkHref, link: linkHref, summary });
  }
  return entries;
}

export async function rssLookup(feedUrl, { limit = 8, timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const url = normalizePublicHttpUrl(feedUrl);
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  const entries = parseRssXml(xml, limit);
  const lines = entries.map((e, i) => (
    `${i + 1}. *${e.title}*\n   🔗 ${e.link}${e.summary ? `\n   _${e.summary}_` : ''}`
  ));
  return {
    ok: entries.length > 0,
    platform: 'rss',
    backend: 'Built-in RSS/Atom Parser',
    url,
    entries,
    text: entries.length
      ? `📰 *RSS Feed (${url})*\n\n${lines.join('\n\n')}`
      : `⚠️ No RSS/Atom items found at ${url}.`,
  };
}

// ── Smart URL Router (`reachUrl`) ────────────────────────────────────────────

export async function reachUrl(rawUrl, options = {}) {
  const url = normalizePublicHttpUrl(rawUrl);
  const platform = detectPlatform(url);

  if (platform === 'youtube') {
    const yt = await youtubeTranscript(url, options);
    if (yt.ok) {
      const m = yt.meta || {};
      const header = [
        `🎬 *${m.title || 'YouTube Video'}*${m.channel ? ` — _${m.channel}_` : ''}${m.duration ? ` (${m.duration})` : ''}`,
        `🔗 ${url} · _via ${yt.backend}_`,
        m.description ? `\n*Description:* ${m.description.slice(0, 350)}` : '',
      ].filter(Boolean).join('\n');
      const body = yt.transcript
        ? `\n\n📝 *Transcript / Subtitles:*\n${yt.transcript.slice(0, options.maxChars ?? 5000)}`
        : '\n\n_(Is video par subtitles available nahi hain)_';
      return { ...yt, text: `${header}${body}` };
    }
  }

  if (platform === 'github') {
    const gh = await githubLookup(url, options);
    if (gh.ok) return gh;
  }

  if (platform === 'twitter') {
    const tw = await twitterLookup(url, options);
    if (tw.ok) return tw;
  }

  if (platform === 'reddit') {
    const rd = await redditLookup(url, options);
    if (rd.ok) return rd;
  }

  if (platform === 'rss') {
    const feed = await rssLookup(url, options);
    if (feed.ok) return feed;
  }

  const page = await readWebUrl(url, options);
  if (page.ok) {
    return {
      ...page,
      text: `🌐 *Web Reader* _(${page.backend})_\n🔗 ${page.url}\n\n${page.content}`,
    };
  }
  return {
    ...page,
    text: `⚠️ Could not read ${url}: ${page.error || 'unknown error'}`,
  };
}

// ── Multi-Platform Parallel Research (`reachResearch`) ───────────────────────

export async function reachResearch(topic, { limit = 4, timeoutMs = 18_000, fetchImpl = fetch } = {}) {
  const q = String(topic ?? '').trim();
  if (!q) throw new Error('Research topic khali hai.');

  const [webRes, ghRes, hnRes, redditRes, soRes] = await Promise.allSettled([
    webSearch(q, { limit, timeoutMs, fetchImpl }),
    githubLookup(q, { mode: 'search', limit: 3, timeoutMs, fetchImpl }),
    hackerNewsLookup(q, { limit: 3, timeoutMs, fetchImpl }),
    redditLookup(q, { limit: 3, timeoutMs, fetchImpl }),
    stackOverflowLookup(q, { limit: 3, timeoutMs, fetchImpl }),
  ]);

  const sections = [
    `🧭 *PSD_Ai Agent-Reach Multi-Platform Research: "${q}"*`,
  ];

  if (webRes.status === 'fulfilled' && webRes.value?.ok) {
    sections.push(webRes.value.text);
  }
  if (ghRes.status === 'fulfilled' && ghRes.value?.ok && ghRes.value.results?.length) {
    sections.push(ghRes.value.text);
  }
  if (hnRes.status === 'fulfilled' && hnRes.value?.ok && hnRes.value.results?.length) {
    sections.push(hnRes.value.text);
  }
  if (redditRes.status === 'fulfilled' && redditRes.value?.ok) {
    sections.push(redditRes.value.text);
  }
  if (soRes.status === 'fulfilled' && soRes.value?.ok && soRes.value.results?.length) {
    sections.push(soRes.value.text);
  }

  return {
    ok: sections.length > 1,
    query: q,
    text: sections.join('\n\n━━━━━━━━━━━━━━━━━━━━\n\n'),
  };
}

// ── Agent-Reach Doctor (`reachDoctor`) ───────────────────────────────────────

export async function reachDoctor() {
  const [ytdlp, gh, opencli, cdp, mcporter, twitter, rdt, bili, ffmpeg, tesseract, xdotool, wmctrl] = await Promise.all([
    probeCommand('yt-dlp', ['--version']),
    probeCommand('gh', ['--version']),
    probeOpenCli(),
    probeBrowserCdp(),
    probeCommand('mcporter', ['--version']),
    probeCommand('twitter', ['--version']),
    probeCommand('rdt', ['--version']),
    probeCommand('bili', ['--version']),
    probeCommand('ffmpeg', ['-version']),
    probeCommand('tesseract', ['--version']),
    probeCommand('xdotool', ['--version']),
    probeCommand('wmctrl', ['--version']),
  ]);

  const profiles = ['chrome', 'chromium', 'brave', 'edge'].flatMap((b) => listBrowserProfiles(b));

  const channels = {
    web: {
      status: 'ok',
      tier: 0,
      name: 'Web Pages & Articles',
      backends: ['Jina Reader', 'Local Markdown Extractor'],
      active_backend: 'Jina Reader + Local Markdown Extractor',
      message: 'Zero-config clean Markdown reading for any public URL',
    },
    search: {
      status: 'ok',
      tier: 0,
      name: 'Web & Tech Search',
      backends: ['Exa MCP', 'DuckDuckGo HTML', 'Wikipedia + HN Algolia'],
      active_backend: mcporter.ok ? 'Exa MCP (mcporter)' : 'DuckDuckGo HTML + Wiki/HN API',
      message: mcporter.ok ? 'Exa AI Search + DuckDuckGo active' : 'DuckDuckGo + Wikipedia + HN Algolia active (zero-config)',
    },
    youtube: {
      status: 'ok',
      tier: 0,
      name: 'YouTube Video & Subtitles',
      backends: ['yt-dlp', 'OpenCLI', 'YouTube CaptionTracks API'],
      active_backend: ytdlp.ok ? `yt-dlp (${ytdlp.output.split('\n')[0]})` : 'YouTube CaptionTracks Web API',
      message: ytdlp.ok
        ? `yt-dlp ready (${ytdlp.output.split('\n')[0]})${ffmpeg.ok ? ' + ffmpeg ready' : ''}`
        : 'Zero-config YouTube search & caption extractor active (install yt-dlp for full format support)',
    },
    github: {
      status: 'ok',
      tier: 0,
      name: 'GitHub Repos, Issues, PRs & Code',
      backends: ['gh CLI', 'GitHub REST API'],
      active_backend: gh.ok ? 'gh CLI + REST API' : 'GitHub REST API',
      message: gh.ok ? `gh CLI ready (${gh.output.split('\n')[0]})` : 'GitHub REST API active (zero-config)',
    },
    hackernews: {
      status: 'ok',
      tier: 0,
      name: 'Hacker News',
      backends: ['HN Algolia API'],
      active_backend: 'HN Algolia API',
      message: 'Top stories & full search active (zero-config)',
    },
    v2ex: {
      status: 'ok',
      tier: 0,
      name: 'V2EX Tech Community',
      backends: ['V2EX Public API'],
      active_backend: 'V2EX Public API',
      message: 'Hot topics & node topics active (zero-config)',
    },
    stackoverflow: {
      status: 'ok',
      tier: 0,
      name: 'StackOverflow Q&A',
      backends: ['StackExchange API'],
      active_backend: 'StackExchange API',
      message: 'Answered programming Q&A search active (zero-config)',
    },
    rss: {
      status: 'ok',
      tier: 0,
      name: 'RSS / Atom Feeds',
      backends: ['Built-in RSS/Atom Parser'],
      active_backend: 'Built-in RSS/Atom Parser',
      message: 'Read any RSS or Atom XML feed (zero-config)',
    },
    reddit: {
      status: 'ok',
      tier: 1,
      name: 'Reddit Discussions & Subreddits',
      backends: ['OpenCLI', 'rdt-cli', 'Reddit JSON', 'PullPush Archive API'],
      active_backend: opencli.ready ? 'OpenCLI' : rdt.ok ? 'rdt-cli' : 'Reddit JSON + PullPush API',
      message: opencli.ready
        ? 'OpenCLI browser session connected'
        : rdt.ok
        ? 'rdt-cli installed'
        : 'Reddit JSON + PullPush Archive active',
    },
    twitter: {
      status: 'ok',
      tier: 1,
      name: 'Twitter / X Tweets & Search',
      backends: ['twitter-cli', 'OpenCLI', 'FxTwitter API'],
      active_backend: twitter.ok ? 'twitter-cli' : opencli.ready ? 'OpenCLI' : 'FxTwitter API (URL reader)',
      message: twitter.ok
        ? 'twitter-cli installed'
        : opencli.ready
        ? 'OpenCLI browser session connected'
        : 'FxTwitter API active for reading any Tweet/X link (install twitter-cli or OpenCLI for keyword search)',
    },
    opencli_bridge: {
      status: opencli.ready ? 'ok' : opencli.installed ? 'warn' : 'off',
      tier: 1,
      name: 'OpenCLI Browser Session Bridge (LinkedIn/IG/FB/XHS/Bilibili)',
      backends: ['OpenCLI', 'Chrome CDP'],
      active_backend: opencli.ready ? `OpenCLI v${opencli.version}` : cdp.active ? `Chrome CDP (${cdp.browser})` : null,
      message: opencli.ready
        ? `Connected to live browser session (v${opencli.version})`
        : cdp.active
        ? `Chrome CDP active on 127.0.0.1:9222 (${cdp.browser})`
        : opencli.hint,
    },
    desktop_grounding: {
      status: (tesseract.ok || xdotool.ok || wmctrl.ok) ? 'ok' : 'warn',
      tier: 0,
      name: 'Agent-S Desktop Grounding (AT-SPI + Window + OCR + SoM)',
      backends: ['AT-SPI Accessibility', 'wmctrl/xdotool', 'Tesseract OCR', 'Set-of-Marks Vision'],
      active_backend: [
        xdotool.ok ? 'xdotool' : null,
        wmctrl.ok ? 'wmctrl' : null,
        tesseract.ok ? 'tesseract' : null,
        'Set-of-Marks',
      ].filter(Boolean).join(' + '),
      message: `Local browser profiles detected: ${profiles.length}`,
    },
  };

  const okCount = Object.values(channels).filter((c) => c.status === 'ok').length;
  const total = Object.keys(channels).length;

  const lines = [
    `🌐 *PSD_Ai × Agent-Reach Doctor* — *${okCount}/${total} channels active*`,
    '_Zero-guesswork internet & desktop capability router_',
    '',
    '*✅ Active Channels & Backends:*',
    ...Object.values(channels).map((c) => {
      const icon = c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '⚪';
      const backend = c.active_backend ? ` _[${c.active_backend}]_` : '';
      return `${icon} *${c.name}*${backend}\n   ${c.message}`;
    }),
    '',
    '*Quick Commands:*',
    '• `/reach <url>` — Read any webpage, YouTube transcript, GitHub repo, Tweet, or Reddit post',
    '• `/reach search <query>` — Multi-backend structured search (no blind browser clicking)',
    '• `/reach research <topic>` — Parallel research across Web + GitHub + HN + Reddit + StackOverflow',
    '• `/reach yt <query or url>` — YouTube search, metadata & full subtitle transcript',
    '• `/reach gh <query or owner/repo>` — GitHub repo/code/issue lookup',
  ];

  return {
    ok: true,
    okCount,
    total,
    channels,
    profiles,
    opencli,
    cdp,
    text: lines.join('\n'),
  };
}

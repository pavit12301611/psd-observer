// model.js — turning raw /proc, MPRIS and notification data into something a
// label can show. Pure, defensive, and the only place that formats numbers.

// ── formatting ──────────────────────────────────────────────────────────────
const EM_DASH = '—';

export function formatBytes(bytes, suffix = '') {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return EM_DASH;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    // Bytes read as whole numbers; everything else keeps one decimal.
    const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
    return `${text} ${units[unit]}${suffix}`;
}

/** Microseconds → m:ss. */
export function formatTime(microseconds) {
    if (!Number.isFinite(microseconds) || microseconds < 0) return '0:00';
    const total = Math.round(microseconds / 1e6);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export const clampPercent = (value) => {
    if (!Number.isFinite(value)) return null;
    return Math.min(100, Math.max(0, value));
};

// ── notifications ───────────────────────────────────────────────────────────
/** Strip Pango markup-ish HTML from notification bodies. */
export function plainText(input) {
    if (input === null || input === undefined) return '';
    return String(input)
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/** Compact preview for the peek card; `truncated` tells the UI to offer "more". */
export function previewText(input, limit = 140) {
    const text = plainText(input);
    if (text.length <= limit) return {text, truncated: false};
    // One character of headroom so the ellipsis never pushes past `limit`.
    return {text: `${text.slice(0, limit)}…`, truncated: true};
}

export function countNotifications(sources) {
    if (!Array.isArray(sources)) return 0;
    let total = 0;
    for (const source of sources) {
        const list = source?.notifications;
        if (Array.isArray(list)) total += list.length;
    }
    return total;
}

// ── media ───────────────────────────────────────────────────────────────────
const unwrap = (value) => {
    if (value && typeof value.deepUnpack === 'function') {
        const inner = value.deepUnpack();
        return inner === value ? value : unwrap(inner);
    }
    return value;
};

export function mediaMetadata(raw) {
    const metadata = unwrap(raw) ?? {};
    const title = unwrap(metadata['xesam:title']);
    const artist = unwrap(metadata['xesam:artist']);
    const length = unwrap(metadata['mpris:length']);
    const trackId = unwrap(metadata['mpris:trackid']);

    let artistText = '';
    if (Array.isArray(artist)) artistText = artist.map((entry) => unwrap(entry)).filter(Boolean).join(', ');
    else if (typeof artist === 'string') artistText = artist;

    return {
        title: typeof title === 'string' ? title : '',
        artist: artistText,
        lengthUs: Number.isFinite(Number(length)) && Number(length) > 0 ? Number(length) : 0,
        trackId: typeof trackId === 'string' && trackId.startsWith('/') ? trackId : '',
    };
}

export function mediaDisplayTitle(player) {
    if (!player) return 'Nothing playing';
    if (player.title) return player.title;
    const app = player.identity || (player.names ?? [])[0];
    if (!app) return 'Nothing playing';
    if (player.status === 'Playing') return `Playing in ${app}`;
    if (player.status === 'Paused') return `Paused in ${app}`;
    return 'Nothing playing';
}

export function mediaDisplayArtist(player) {
    if (!player) return '';
    if (player.artist) return player.artist;
    return player.identity || (player.names ?? [])[0] || '';
}

/**
 * Seek target in microseconds, clamped to the track.
 *
 * `deltaSeconds` is a relative offset: negative rewinds. It is floored at zero,
 * so a player reporting a stale or negative position can never produce a seek
 * outside the track. `lengthUs` bounds the far end when it is known.
 */
export function seekTarget(positionUs, deltaSeconds = 0, lengthUs = 0) {
    const position = Number.isFinite(positionUs) ? positionUs : 0;
    const delta = (Number(deltaSeconds) || 0) * 1e6;
    const bounds = Number.isFinite(lengthUs) && lengthUs > 0;
    // Seeking *forward* into an unknown track is a guess; rewinding to the
    // start is always safe. So without a length, only a rewind moves.
    if (delta > 0 && !bounds) return position;
    const target = position + delta;
    if (target <= 0) return 0;
    return bounds ? Math.min(lengthUs, target) : target;
}

/**
 * The concrete skip the UI uses. Kept separate so the ± jump size lives in one
 * place instead of being sprinkled through the buttons.
 */
export const SKIP_SECONDS = 15;
export function skipTarget(positionUs, forward, lengthUs = 0) {
    return seekTarget(positionUs, forward ? SKIP_SECONDS : -SKIP_SECONDS, lengthUs);
}

/** Raw D-Bus errors are noise; say what the owner can do instead. */
export function mediaErrorMessage(error) {
    const text = String(error ?? '');
    if (!text) return 'Media command failed.';
    if (/NotSupported/i.test(text)) return 'This player does not support that control.';
    if (/NameHasNoOwner|not responding|Timeout/i.test(text)) return 'The media player is not responding.';
    if (/AccessDenied|NotAuthorized/i.test(text)) return 'The media player blocked that command.';
    return `Media: ${text.slice(0, 160)}`;
}

// ── the closed-notch equaliser ───────────────────────────────────────────────
// Eight rhythmic frames, 3 bars each, looping. All values sit in 0.25..1 so the
// bars never vanish, and the sequence is long enough to read as motion.
const VISUALIZER = Object.freeze([
    [0.35, 0.85, 0.5],
    [0.6, 1.0, 0.4],
    [0.9, 0.45, 0.7],
    [0.5, 0.75, 1.0],
    [0.75, 0.4, 0.6],
    [1.0, 0.9, 0.35],
    [0.45, 0.6, 0.85],
    [0.8, 0.5, 0.65],
]);

export function visualizerLevels(step) {
    const index = ((Math.trunc(step) % VISUALIZER.length) + VISUALIZER.length) % VISUALIZER.length;
    return [...VISUALIZER[index]];
}

// ── battery ─────────────────────────────────────────────────────────────────
const CHARGING_STATE = 1;
// States a battery passes through before it actually starts charging. State 4
// ("not charging") is deliberately absent: it is what UPower reports for a few
// seconds right after a change, and announcing then would badge a false start.
const PRE_CHARGE_STATES = new Set([2, 5, 6]); // discharging, pending-charge, fully-charged

/** True only when charging genuinely begins, never on a re-report. */
export function chargingStarted(previous, current) {
    if (!previous?.available || !current?.available) return false;
    if (!PRE_CHARGE_STATES.has(previous.state)) return false;
    return current.state === CHARGING_STATE;
}

// ── /proc sampling ──────────────────────────────────────────────────────────
/**
 * CPU percentage from a /proc/stat `cpu` line.
 * Guest time is already counted inside user/nice, so it must not be added again.
 */
export function cpuSample(text, previousRaw = null) {
    const line = String(text ?? '').split('\n').find((row) => row.startsWith('cpu '));
    if (!line) return {percent: null, raw: previousRaw ?? null};
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    if (values.length < 5 || values.some((value) => !Number.isFinite(value)))
        return {percent: null, raw: previousRaw ?? null};
    const [user, nice, system, idle, iowait] = values;
    // iowait counts as idle for the busy fraction, which is what people expect.
    const total = user + nice + system + idle + iowait +
        (values[5] ?? 0) + (values[6] ?? 0);
    const raw = {total, idle: idle + iowait};
    if (!previousRaw) return {percent: null, raw};
    const deltaTotal = raw.total - previousRaw.total;
    const deltaIdle = raw.idle - previousRaw.idle;
    // Counters reset (suspend/resume): report nothing rather than a spike.
    if (deltaTotal <= 0 || deltaIdle < 0) return {percent: null, raw};
    const percent = ((deltaTotal - deltaIdle) / deltaTotal) * 100;
    return {percent: Math.min(100, Math.max(0, percent)), raw};
}

/** RAM used, from MemAvailable — MemFree understates what the kernel can reclaim. */
export function memorySample(text) {
    const read = (key) => {
        const match = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(String(text ?? ''));
        return match ? Number(match[1]) : null;
    };
    const totalKb = read('MemTotal');
    const availableKb = read('MemAvailable');
    if (!totalKb || availableKb === null) return {percent: null, used: null, total: null};
    const used = (totalKb - availableKb) * 1024;
    const percent = ((totalKb - availableKb) / totalKb) * 100;
    return {percent: Math.min(100, Math.max(0, percent)), used, total: totalKb * 1024};
}

/** Which interface carries the default route (for rate sampling). */
export function defaultRouteInterface(text) {
    const rows = String(text ?? '').trim().split('\n').slice(1);
    for (const row of rows) {
        const columns = row.trim().split(/\s+/);
        // The default route has destination 00000000.
        if (columns[1] === '00000000') return columns[0];
    }
    return '';
}

export function networkSample(text, previousRaw = null, elapsedSeconds = 0) {
    const lines = String(text ?? '').split('\n');
    const interfaces = new Map();
    for (const line of lines) {
        const match = /^\s*([\w.:-]+):\s*(.*)$/.exec(line);
        if (!match) continue;
        const [, name, rest] = match;
        if (name === 'lo') continue;
        const columns = rest.trim().split(/\s+/).map(Number);
        if (columns.length < 9 || !Number.isFinite(columns[0])) continue;
        interfaces.set(name, {rx: columns[0], tx: columns[8]});
    }
    const preferred = previousRaw?.interface && interfaces.has(previousRaw.interface)
        ? previousRaw.interface
        : interfaces.keys().next().value;
    if (!preferred) return {download: null, upload: null, raw: previousRaw ?? null};
    const counters = interfaces.get(preferred);
    const raw = {...counters, interface: preferred};
    if (!previousRaw || previousRaw.interface !== preferred || !(elapsedSeconds > 0))
        return {download: null, upload: null, raw};
    const deltaRx = counters.rx - previousRaw.rx;
    const deltaTx = counters.tx - previousRaw.tx;
    // A counter that went backwards means the interface was reset: say nothing.
    if (deltaRx < 0 || deltaTx < 0) return {download: null, upload: null, raw};
    return {
        download: deltaRx / elapsedSeconds,
        upload: deltaTx / elapsedSeconds,
        raw,
    };
}

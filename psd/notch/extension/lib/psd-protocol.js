// psd-protocol.js — the Agent tab's wire format, with no GNOME dependency.
//
// This file is deliberately free of `gi://` imports so the framing and the
// footer text can be unit-tested (and reasoned about) outside the Shell.
// psd.js does the Soup work; psd-page.js does the widgets.

/**
 * Parse a chunk of a `text/event-stream` body.
 *
 * Soup hands us arbitrary slices, so a frame can be split anywhere — including
 * in the middle of a JSON number. Anything after the last blank line is
 * returned as `rest` for the next call.
 *
 * @param {string} chunk
 * @returns {{events: Array<{event: string, data: any}>, rest: string}}
 */
export function parseSseChunk(chunk) {
    const text = String(chunk ?? '');
    if (!text) return {events: [], rest: ''};

    const events = [];
    let cursor = 0;
    for (;;) {
        const boundary = text.indexOf('\n\n', cursor);
        if (boundary < 0) break;
        const block = text.slice(cursor, boundary);
        cursor = boundary + 2;
        const event = parseBlock(block);
        if (event) events.push(event);
    }
    return {events, rest: text.slice(cursor)};
}

function parseBlock(block) {
    let name = 'message';
    const data = [];
    let sawData = false;
    for (const rawLine of block.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        // Comment / heartbeat: ": ping".
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') name = value;
        else if (field === 'data') {
            sawData = true;
            data.push(value);
        }
    }
    // A block with no data line is not an event we can act on.
    if (!sawData) return null;
    const payload = data.join('\n');
    let parsed;
    try {
        parsed = JSON.parse(payload);
    } catch {
        // PSD streams plain deltas too; a bare string is still useful.
        parsed = {text: payload};
    }
    return {event: name, data: parsed};
}

/**
 * Normalise what a human types into a base URL: `pc:7788` → `http://pc:7788`.
 * Empty stays empty so the tab can show its "not configured" state.
 */
export function normalizeBaseUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text.replace(/\/+$/, '');
    return `http://${text.replace(/\/+$/, '')}`;
}

/**
 * The one-line footer under an answer. It must never lie: no latency figure
 * unless we measured one, no tool list unless tools actually ran.
 *
 * @param {{path?: string, toolsUsed?: string[]}} answer
 * @param {number} ms measured round trip
 */
export function describeAnswer(answer, ms = 0) {
    const parts = [];
    const path = answer?.path ? String(answer.path) : '';
    if (path) parts.push(path);

    const tools = Array.isArray(answer?.toolsUsed) ? answer.toolsUsed.filter(Boolean) : [];
    if (tools.length) parts.push(tools.slice(0, 3).join(', '));

    if (Number.isFinite(ms) && ms > 0) {
        parts.push(ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
    }
    return parts.join(' · ');
}

/** Status dot for a stream state, so the page and the pill agree. */
export function dotForState(state) {
    switch (state) {
    case 'streaming':
    case 'thinking':
        return 'busy';
    case 'ok':
        return 'ok';
    case 'warn':
        return 'warn';
    case 'bad':
    case 'unconfigured':
    case 'no-token':
        return 'bad';
    default:
        return 'idle';
    }
}

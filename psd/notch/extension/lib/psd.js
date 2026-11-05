// psd.js — the Agent tab's HTTP client. Soup 3, streaming, cancellable.
//
// The tab must never block the Shell: every request goes through Soup's async
// API and reports progress by signal. A streamed answer arrives as SSE frames
// on /psd/chat/stream; the framing itself lives in psd-protocol.js so it can be
// tested without GNOME.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import {parseSseChunk, normalizeBaseUrl} from './psd-protocol.js';

const TIMEOUT_SECONDS = 120;

export class PsdClient {
    /**
     * @param {object} options
     * @param {Gio.Settings} options.settings the extension settings
     * @param {Function} [options.onToken] called with each streamed text delta
     * @param {Function} [options.onEvent] called with every parsed SSE event
     */
    constructor({settings, onToken = null, onEvent = null} = {}) {
        this.settings = settings;
        this.onToken = onToken;
        this.onEvent = onEvent;
        this.session = new Soup.Session({timeout: TIMEOUT_SECONDS});
        this.session.user_agent = 'notch-psd/1.0';
        this.cancellable = null;
        this.lastError = '';
        this.token = '';
        this.loadToken();
    }

    get baseUrl() {
        try {
            return normalizeBaseUrl(this.settings.get_string('psd-url'));
        } catch {
            return '';
        }
    }

    /**
     * Resolve the token, preferring a freshly written one on disk.
     * Called by Preferences → Agent → Test after the owner saves a URL.
     */
    async resolveToken() {
        const fromSettings = (this.settings.get_string('psd-token') ?? '').trim();
        if (fromSettings) {
            this.token = fromSettings;
            return this.token;
        }
        this.token = this._tokenFromDisk() ?? '';
        return this.token;
    }

    /**
     * The token. Settings first (the owner may paste one), then the CLI's
     * token file, so a fresh install works with nothing typed.
     */
    loadToken() {
        let token = '';
        try {
            token = this.settings.get_string('psd-token').trim();
        } catch {
            token = '';
        }
        if (!token) token = this._tokenFromDisk() ?? '';
        this.token = token;
        return token;
    }

    _tokenFromDisk() {
        const dataDir = GLib.getenv('XDG_DATA_HOME') ||
            GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share']);
        const file = GLib.build_filenamev([dataDir, 'psd', 'token.txt']);
        try {
            const [, bytes] = Gio.File.new_for_path(file).load_contents(null);
            return new TextDecoder().decode(bytes).trim();
        } catch {
            return null;
        }
    }

    _buildMessage(path, body = null) {
        const base = this.baseUrl;
        if (!base) throw new Error('Set the PSD URL in Preferences → Agent.');
        const message = Soup.Message.new('POST', `${base}${path}`);
        if (!message) throw new Error(`Invalid PSD URL: ${base}`);
        message.request_headers.append('accept', 'text/event-stream, application/json');
        message.request_headers.append('content-type', 'application/json');
        const token = this.token || this.loadToken();
        if (token) message.request_headers.append('x-psd-token', token);
        // The extension is a browser-shaped client, so say where it is from:
        // PSD trusts same-machine origins and refuses everything else.
        message.request_headers.append('origin', base);
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body ?? {}))));
        return message;
    }

    /** One request/response. Resolves with the parsed JSON body. */
    async request(path, body = null) {
        const message = this._buildMessage(path, body);
        const bytes = await this._send(message);
        const text = new TextDecoder().decode(bytes.get_data() ?? []);
        if (!text) return {};
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`PSD sent something unexpected: ${text.slice(0, 80)}`);
        }
    }

    _send(message) {
        return new Promise((resolve, reject) => {
            this.cancellable = new Gio.Cancellable();
            this.session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this.cancellable,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.get_status();
                        if (status !== Soup.Status.OK) {
                            const detail = new TextDecoder().decode(bytes?.get_data() ?? '');
                            reject(new Error(this._describe(status, detail)));
                            return;
                        }
                        resolve(bytes);
                    } catch (error) {
                        reject(new Error(this._describe(null, error.message)));
                    }
                });
        });
    }

    _describe(status, detail) {
        const message = String(detail ?? '');
        let hint = '';
        if (status === Soup.Status.UNAUTHORIZED) hint = 'PSD needs its token — run `psd token`.';
        else if (status === Soup.Status.FORBIDDEN) hint = 'PSD refused this page origin. Check PSD_CORS_ORIGIN.';
        else if (status === Soup.Status.NOT_FOUND) hint = 'The endpoint is not there — is this the right URL?';
        else if (!status) hint = 'PSD is not answering. Is `psd` running?';
        let parsed = '';
        try {
            const data = JSON.parse(message);
            parsed = data.detail || data.error || '';
        } catch {
            parsed = message.slice(0, 120);
        }
        this.lastError = [hint, parsed].filter(Boolean).join(' ');
        return this.lastError || `PSD returned HTTP ${status}`;
    }

    /**
     * Health + surfaces snapshot, used by the tab's status line.
     * `maxAgeMs: 0` asks PSD to re-probe rather than answer from cache.
     */
    async status({maxAgeMs = null} = {}) {
        const fresh = maxAgeMs === 0 || maxAgeMs === undefined && false;
        return this.request(fresh ? '/psd/status?probe=1' : '/psd/status');
    }

    /** Re-probe the brain from the tab. */
    async probe() {
        const data = await this.request('/psd/status?probe=1');
        return data?.brain ?? null;
    }

    async tools() {
        const data = await this.request('/psd/tools');
        return data?.tools ?? [];
    }

    async agents() {
        const data = await this.request('/psd/agents');
        return data ?? {agents: [], skills: []};
    }

    /**
     * Stream an answer.
     *
     * @param {string} text the owner's message
     * @param {object} [options] {thread, onDone}
     * @returns {Promise<object>} the final `done` payload
     */
    async chat(text, {thread = 'notch'} = {}) {
        const message = this._buildMessage('/psd/chat/stream', {text, source: 'notch', thread});
        const startedAt = GLib.get_monotonic_time() / 1000;
        let tail = '';
        let done = null;

        await new Promise((resolve, reject) => {
            this.cancellable = new Gio.Cancellable();
            this.session.send_async(message, GLib.PRIORITY_DEFAULT, this.cancellable, (session, result) => {
                let stream;
                try {
                    stream = session.send_finish(result);
                } catch (error) {
                    reject(new Error(this._describe(null, error.message)));
                    return;
                }
                const status = message.get_status();
                if (status !== Soup.Status.OK) {
                    reject(new Error(this._describe(status, '')));
                    return;
                }
                this._readStream(stream, (chunk) => {
                    const {events, rest} = parseSseChunk(tail + chunk);
                    tail = rest;
                    for (const event of events) {
                        this.onEvent?.(event);
                        if (event.event === 'token' && event.data?.text) this.onToken?.(event.data.text);
                        if (event.event === 'done') done = event.data;
                        if (event.event === 'error') this.lastError = event.data?.detail || 'PSD reported an error';
                    }
                }, () => {
                    // Flush whatever is left: a well-formed final frame may not
                    // end with a blank line.
                    if (tail.trim()) {
                        const {events} = parseSseChunk(`${tail}\n\n`);
                        for (const event of events) {
                            this.onEvent?.(event);
                            if (event.event === 'token' && event.data?.text) this.onToken?.(event.data.text);
                            if (event.event === 'done') done = event.data;
                        }
                    }
                    const elapsedMs = Math.round(GLib.get_monotonic_time() / 1000 - startedAt);
                    resolve();
                }, (error) => reject(new Error(this._describe(null, error.message))));
            });
        });

        return done ?? {text: '', path: '', ms: 0, streamed: ''};
    }

    /** Read a GInputStream chunk by chunk without buffering the whole answer. */
    _readStream(stream, onText, onEnd, onError) {
        const decoder = new TextDecoder();
        const pump = () => {
            stream.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, this.cancellable, (source, result) => {
                let bytes;
                try {
                    bytes = source.read_bytes_finish(result);
                } catch (error) {
                    if (this.cancellable?.is_cancelled()) { onEnd(); return; }
                    onError(error);
                    return;
                }
                const data = bytes?.get_data();
                if (!data || data.length === 0) { onEnd(); return; }
                onText(decoder.decode(data, {stream: true}));
                pump();
            });
        };
        pump();
    }

    /** Stop an in-flight answer (the Stop button, or leaving the tab). */
    cancel() {
        try {
            this.cancellable?.cancel();
        } catch {
            /* already done */
        }
    }

    destroy() {
        this.cancel();
        try {
            this.session.abort();
        } catch {
            /* nothing in flight */
        }
        this.session = null;
    }
}

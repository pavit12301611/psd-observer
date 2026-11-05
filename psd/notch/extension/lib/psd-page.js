// psd-page.js — the Agent tab: a conversation with PSD inside the notch.
//
// Layout mirrors the phone app so the two feel like one product:
//   strip   status dot · model/tools · stop
//   list    bubbles (role, body, footer with path/tools/latency)
//   prompt  entry + send
//   chips   suggestions when the thread is empty
//
// The page owns no HTTP logic; it drives PsdClient and renders what it reports.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {PsdClient} from './psd.js';
import {describeAnswer, dotForState} from './psd-protocol.js';
import {box, button, label, setSensitive, setText, wrapLabel} from './widgets.js';

const CHIPS = [
    ['System status', 'system status'],
    ['Disk', 'how much disk space do i have'],
    ['Screenshot', 'take a screenshot'],
    ['Windows', 'what windows are open'],
    ['Focus', 'dark mode on'],
    ['Test', 'notch: PSD is live'],
];

class Bubble extends St.BoxLayout {
    constructor(role, text = '') {
        super({vertical: true, x_expand: true});
        this.add_style_class_name(`psd-bubble psd-bubble-${role}`);
        this.role = role;

        this.header = label(role === 'user' ? 'You' : 'PSD', 'psd-bubble-role');
        this.body = wrapLabel(text, `psd-bubble-body psd-bubble-body-${role}`);
        this.footer = label('', 'psd-bubble-footer');

        this.add_child(this.header);
        this.add_child(this.body);
        this.footer.visible = false;
        this.add_child(this.footer);
    }

    setText(text) {
        setText(this.body, text);
    }

    append(text) {
        this.body.text = `${this.body.text}${text}`;
    }

    setFooter(text) {
        setText(this.footer, text);
        this.footer.visible = Boolean(text);
    }
}

export class PsdPage {
    /**
     * @param {object} options
     * @param {Gio.Settings} options.settings
     * @param {Function} [options.relayout] ask the view to resize after a change
     * @param {Function} [options.reveal] open the Agent tab (from a pushed card)
     */
    constructor({settings, relayout = () => {}, reveal = () => {}} = {}) {
        this.settings = settings;
        this.relayout = relayout;
        this.reveal = reveal;
        this.busy = false;
        this.thread = 'notch';
        this.lastState = 'idle';
        this.client = new PsdClient({
            settings,
            onToken: (delta) => this._onToken(delta),
            onEvent: (event) => this._onEvent(event),
        });

        this.page = box(true, 'psd-page', 8);
        this.page.x_expand = true;

        this.scroll = new St.ScrollView({
            style_class: 'psd-scroll',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this.stack = new St.Widget({layout_manager: new Clutter.BinLayout(), y_expand: true});
        this.list = box(true, 'psd-list', 8);
        this.list.x_expand = true;
        this.empty = this._buildEmpty();
        this.stack.add_child(this.empty);
        this.stack.add_child(this.scroll);
        this.scroll.child = this.list;
        // The empty state shows until the first message.
        this.scroll.visible = false;

        this.page.add_child(this._buildStrip());
        this.page.add_child(this.stack);
        this.page.add_child(this._buildPrompt());
        this.page.add_child(this._buildChips());

        this._setState('idle');
    }

    // ── construction ────────────────────────────────────────────────────────
    _buildEmpty() {
        const container = box(true, 'psd-empty', 4);
        container.x_align = Clutter.ActorAlign.CENTER;
        container.y_align = Clutter.ActorAlign.CENTER;
        container.x_expand = true;
        container.y_expand = true;
        const title = label('Ask PSD anything', 'psd-empty-title');
        title.x_align = Clutter.ActorAlign.CENTER;
        this.emptyLine = wrapLabel('Same brain as your phone and WhatsApp. It can read this machine, not just talk about it.',
            'psd-empty-body');
        this.emptyLine.x_align = Clutter.ActorAlign.CENTER;
        container.add_child(title);
        container.add_child(this.emptyLine);
        return container;
    }

    _buildStrip() {
        const strip = box(false, 'psd-strip', 6);
        strip.x_expand = true;
        this.statusDot = new St.Widget({style_class: 'psd-dot', y_align: Clutter.ActorAlign.CENTER});
        this.statusLabel = label('checking…', 'psd-status');
        this.toolsLabel = label('', 'psd-tools');
        this.toolsLabel.x_expand = true;
        this.toolsLabel.x_align = Clutter.ActorAlign.START;
        this.stopButton = button({text: 'stop', style: 'psd-chip', onClick: () => this.stop()});
        this.stopButton.visible = false;

        strip.add_child(this.statusDot);
        strip.add_child(this.statusLabel);
        strip.add_child(this.toolsLabel);
        strip.add_child(this.stopButton);
        return strip;
    }

    _buildPrompt() {
        const row = box(false, 'psd-prompt', 6);
        row.x_expand = true;
        this.entry = new St.Entry({
            style_class: 'psd-entry',
            can_focus: true,
            x_expand: true,
            hint_text: 'Ask PSD…',
            text: '',
        });
        this.entry.clutter_text.connect('activate', () => this.send());
        // Enter sends; the notched entry has no room for a multiline composer.
        this.entry.clutter_text.connect('key-press-event', (actor, event) => {
            const symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape) { this.stop(); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });
        this.sendButton = button({
            iconName: 'edit-clear-all-symbolic',
            style: 'psd-send',
            accessibleName: 'Send to PSD',
            onClick: () => this.send(),
        });
        row.add_child(this.entry);
        row.add_child(this.sendButton);
        return row;
    }

    _buildChips() {
        this.chips = box(false, 'psd-chips', 6);
        this.chips.x_align = Clutter.ActorAlign.CENTER;
        this.chipButtons = CHIPS.map(([text, prompt], index) => {
            const chip = button({
                text,
                style: index === 0 ? 'psd-chip psd-chip-accent' : 'psd-chip',
                onClick: () => this.send(prompt),
            });
            this.chips.add_child(chip);
            return chip;
        });
        return this.chips;
    }

    // ── lifecycle ───────────────────────────────────────────────────────────
    /** Called when the Agent tab becomes visible. */
    activate() {
        this._refreshStatus();
        if (this.entry) this.entry.grab_key_focus();
    }

    deactivate() {
        // Nothing to tear down: a stream in flight keeps running so its answer
        // is there when the owner comes back.
    }

    async _refreshStatus() {
        if (!this.client.baseUrl) {
            this._setState('unconfigured');
            this.updateStatus('set the PSD URL in settings', 'bad');
            return;
        }
        try {
            const health = await this.client.status();
            const brain = health?.brain;
            const access = health?.access;
            const model = brain?.healthy ? (brain.model || 'model') : 'intents';
            this.updateStatus(`${model}${access?.level ? ` · ${access.level}` : ''}`,
                brain?.healthy ? 'ok' : 'warn');
            const tools = access?.tools ? `${access.tools} tools` : '';
            setText(this.toolsLabel, tools);
        } catch (error) {
            this._setState('bad');
            this.updateStatus(this.client.lastError || 'PSD is not answering', 'bad');
        }
    }

    updateStatus(text, dotState = 'idle') {
        setText(this.statusLabel, text);
        this.statusDot.style_class = `psd-dot psd-dot-${dotState}`;
    }

    _setState(state) {
        this.lastState = state;
        if (state === 'unconfigured') this.updateStatus('set the PSD URL in settings', 'bad');
        if (state === 'no-token') this.updateStatus('token missing — run `psd doctor`', 'bad');
        if (state === 'streaming') this.updateStatus('working…', 'busy');
        this.setBusy(state === 'streaming');
    }

    setBusy(busy) {
        this.busy = Boolean(busy);
        setSensitive(this.sendButton, !this.busy);
        this.stopButton.visible = this.busy;
        if (this.chips) this.chips.opacity = this.busy ? 120 : 255;
    }

    /** What the notch's closed pill and D-Bus PsdState report. */
    state() {
        return {
            state: this.busy ? 'streaming' : this.lastState,
            messages: this.list.get_n_children(),
            thread: this.thread,
        };
    }

    // ── chatting ────────────────────────────────────────────────────────────
    async send(preset = null) {
        const text = String(preset ?? this.entry?.get_text() ?? '').trim();
        if (!text || this.busy) return;
        if (!this.client.baseUrl) {
            this._setState('unconfigured');
            return;
        }

        this.entry.set_text('');
        this._showThread();
        this._addBubble('user', text);
        const answer = this._addBubble('agent', '');
        answer.body.text = '…';

        this._setState('streaming');
        this.currentAnswer = answer;
        this.currentText = '';

        try {
            const done = await this.client.chat(text, {thread: this.thread});
            const finalText = (done?.text ?? this.currentText ?? '').trim();
            answer.setText(finalText || 'No answer.');
            answer.setFooter(describeAnswer(done, done?.ms));
            this._setState(done?.ok === false ? 'bad' : 'ok');
            if (done?.ok !== false) this.updateStatus('ready', 'ok');
        } catch (error) {
            answer.setText(this.client.lastError || error.message || 'PSD did not answer.');
            answer.setFooter('');
            this._setState('bad');
            this.updateStatus('failed — press ask to retry', 'bad');
        } finally {
            this.currentAnswer = null;
            this.setBusy(false);
            this.relayout();
        }
    }

    stop() {
        if (!this.busy) return;
        this.client.cancel();
        this.updateStatus('stopped', 'warn');
        this.setBusy(false);
    }

    _onToken(delta) {
        if (!this.currentAnswer) return;
        this.currentText = `${this.currentText ?? ''}${delta}`;
        this.currentAnswer.setText(this.currentText);
    }

    _onEvent(event) {
        if (event.event === 'tool') {
            const name = event.data?.name;
            if (name) this.updateStatus(`running ${name}…`, 'busy');
        }
        if (event.event === 'token' && !this.currentText) this._setState('streaming');
    }

    // ── thread rendering ────────────────────────────────────────────────────
    _showThread() {
        if (this.empty?.visible) this.empty.visible = false;
        if (!this.scroll.visible) this.scroll.visible = true;
        if (this.chips?.visible) this.chips.visible = false;
    }

    _addBubble(role, text) {
        const bubble = new Bubble(role, text);
        this.list.add_child(bubble);
        this._scrollToBottom();
        return bubble;
    }

    _scrollToBottom() {
        // One idle hop so the allocation is up to date before we scroll.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                const adjustment = this.scroll.vadjustment;
                adjustment.value = adjustment.upper - adjustment.page_size;
            } catch {
                /* not allocated yet */
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /** A card pushed from the agent (D-Bus PsdMessage kind=card). */
    receive({title, body} = {}) {
        this._showThread();
        const bubble = this._addBubble('agent', '');
        bubble.setText(`${title ?? 'PSD'}${body ? `\n${body}` : ''}`);
        bubble.setFooter('pushed');
        if (this.empty?.visible) this.empty.visible = false;
    }

    destroy() {
        this.client?.destroy();
        this.client = null;
    }
}

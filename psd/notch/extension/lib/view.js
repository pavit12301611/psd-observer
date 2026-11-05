// view.js — the notch itself: a pill that opens into a five-page panel.
//
// Structure
//   shell ─ closed pill (clock / live status / media wings)
//          └ surface ─ content ─ header (tabs + controls)
//                               ├ pageStack (home · agent · media · alerts · system)
//                               └ status bar (transient messages + Retry)
//
// Rules that keep this pleasant to live with:
//   • the pill never steals a click it does not use (reactive=false when closed)
//   • opening and closing run on one spring, retargetable mid-flight
//   • the header chooses labels/icons/ultra by measured width, never overflow
//   • every teardown path removes actors, timers, signals and settings handlers

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PAGE_SIZES, containsPoint, notchGeometry} from './geometry.js';
import {TAB_COUNT, contentLayout, headerLayout, statColumns} from './layout.js';
import {NotificationBridge} from './notifications.js';
import {SpringGeometry, SPRING_PROFILES, easeOutCubic} from './spring.js';
import {
    chargingStarted, countNotifications, cpuSample, defaultRouteInterface, formatBytes,
    formatTime, mediaDisplayArtist, mediaDisplayTitle, mediaErrorMessage, mediaMetadata,
    memorySample, networkSample, plainText, previewText, visualizerLevels,
} from './model.js';
import {PsdPage} from './psd-page.js';
import {box, button, emptyState, icon, label, setIconSource, setSensitive, setText, sourceIcon, wrapLabel} from './widgets.js';

const MEDIA_POLL_MS = 2000;
const SYSTEM_POLL_MS = 2500;
const CLOCK_MS = 10000;
const EQ_MS = 260;

const TABS = [
    {id: 'home', title: 'Home', icon: 'user-home-symbolic'},
    {id: 'chat', title: 'Agent', icon: 'psd-symbolic'},
    {id: 'media', title: 'Media', icon: 'audio-x-generic-symbolic'},
    {id: 'notifications', title: 'Alerts', icon: 'preferences-system-notifications-symbolic'},
    {id: 'system', title: 'System', icon: 'utilities-system-monitor-symbolic'},
];

export class NotchView {
    constructor(extension) {
        this.extension = extension;
        this.settings = extension.settings ?? extension.getSettings();
        this.dir = Gio.File.new_for_path(extension.dir ?? extension.path ??
            GLib.build_filenamev([GLib.get_home_dir(), '.local/share/gnome-shell/extensions', 'notch@pavit12301611.github.io']));
        this.dead = false;
        this.expanded = false;
        this.tab = 'home';
        this.mode = 'closed';
        this.monitor = null;
        this.hovered = false;
        this.allowed = true;
        this.externalStatus = null;
        this.notificationCount = 0;
        this.media = null;
        this.system = null;
        this.previousRaw = {cpu: null, net: null, netAt: 0};
        this.battery = null;
        this.lastPushed = 0;
        this.timers = new Set();
        this.eqStep = 0;

        this.geometry = new SpringGeometry(notchGeometry(this._monitor(), this._options(), false));
        this.geometry.snap(this.geometry.current);

        this._buildShell();
        this._connectSettings();
        this._installDbusProbe();
        this._startLoops();

        this._applyGeometry();
        this.setExpanded(false, {immediate: true});
        this._refreshAll();
    }

    // ── settings & geometry helpers ─────────────────────────────────────────
    _monitor() {
        const display = global.backend?.get_monitor_manager?.()?.get_current_monitor?.();
        if (!display) return {x: 0, y: 0, width: 1920, height: 1080};
        const geometry = display.get_geometry();
        return {x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height};
    }

    _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor ?? 1;
    }

    _panelHeight() {
        if (this.settings.get_boolean('match-panel-height') && Main.panel) {
            const height = Main.panel.height;
            if (height > 0) return height;
        }
        return this.settings.get_int('collapsed-height');
    }

    _options(extra = {}) {
        return {
            collapsedWidth: this.settings.get_int('collapsed-width'),
            collapsedHeight: this.settings.get_int('collapsed-height'),
            expandedWidth: this.settings.get_int('expanded-width'),
            expandedHeight: this.settings.get_int('expanded-height'),
            placement: this.settings.get_string('placement'),
            floatingMargin: this.settings.get_int('floating-margin'),
            horizontalOffset: this.settings.get_int('horizontal-offset'),
            cornerRadius: this.settings.get_int('corner-radius'),
            adaptiveCorners: this.settings.get_boolean('adaptive-corners'),
            matchPanelHeight: this.settings.get_boolean('match-panel-height'),
            panelHeight: this._panelHeight(),
            cssScale: this._scale(),
            layoutScale: this.settings.get_double('notch-scale'),
            textScale: 1,
            tab: this.tab,
            ...extra,
        };
    }

    // ── construction ────────────────────────────────────────────────────────
    _buildShell() {
        this.actor = new St.Widget({
            name: 'notch',
            reactive: false,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
            visible: false,
        });
        this.actor.add_style_class_name('notch-shell');

        this.surface = new St.Widget({
            style_class: 'notch-surface',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
        });

        this.closed = this._buildClosed();
        this.content = this._buildContent();
        this.surface.add_child(this.content);
        this.surface.add_child(this.closed);

        this.peek = this._buildPeek();
        this.surface.add_child(this.peek);

        this.actor.add_child(this.surface);
        Main.layoutManager.addChrome(this.actor, {affectsInputRegion: true, trackFullscreen: true});
        this.actor.visible = true;

        this.actor.connectObject('enter-event', () => {
            this.hovered = true;
            this._cancelTimer('close');
            this._cancelTimer('hover');
            if (this.mode === 'closed' && this.settings.get_boolean('open-on-hover')) {
                this._after(this.settings.get_int('hover-delay-ms'), 'hover', () => {
                    if (this.hovered && this.mode === 'closed') this.setExpanded(true);
                });
            }
            this._applyGeometry();
            return Clutter.EVENT_PROPAGATE;
        }, this.actor);
        this.actor.connectObject('leave-event', () => {
            this.hovered = false;
            this._cancelTimer('hover');
            this._scheduleAutoClose();
            this._applyGeometry();
            return Clutter.EVENT_PROPAGATE;
        }, this.actor);

        global.display.connectObject('notify::focus-window', () => this._evaluateVisibility(), this.actor);
        global.window_manager.connectObject('switch-workspace', () => this._applyGeometry(), this.actor);
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this.actor);
        Main.overview.connectObject('showing', () => {
            if (this.settings.get_boolean('hide-in-overview')) this.actor.visible = false;
        }, this.actor);
        Main.overview.connectObject('hidden', () => {
            this.actor.visible = true;
            this._evaluateVisibility();
        }, this.actor);
    }

    _buildClosed() {
        const container = new St.Widget({style_class: 'notch-closed', layout_manager: new Clutter.BinLayout()});
        const row = box(false, 'notch-closed-row', 8);
        row.x_align = Clutter.ActorAlign.CENTER;
        row.y_align = Clutter.ActorAlign.CENTER;

        this.liveBars = box(false, 'notch-live-bars', 3);
        this.liveBars.visible = false;
        this.liveBarActors = [0, 1, 2].map(() => {
            const bar = new St.Widget({style_class: 'notch-live-bar', y_align: Clutter.ActorAlign.CENTER});
            this.liveBars.add_child(bar);
            return bar;
        });

        this.clockBox = box(false, 'notch-clock-box', 6);
        this.clockLabel = label('', 'notch-summary-clock');
        this.unreadDot = new St.Widget({style_class: 'notch-unread-dot', y_align: Clutter.ActorAlign.CENTER});
        this.unreadDot.visible = false;
        this.clockBox.add_child(this.clockLabel);
        this.clockBox.add_child(this.unreadDot);

        this.mediaMarks = box(false, 'notch-live-music', 6);
        this.mediaMarks.visible = false;
        this.chargeBadge = box(false, 'notch-charge-badge', 4);
        this.chargeBadge.visible = false;
        this.chargeLabel = label('', 'notch-charge-label');
        this.chargeBadge.add_child(icon('battery-charging-symbolic', 12));
        this.chargeBadge.add_child(this.chargeLabel);

        row.add_child(this.liveBars);
        row.add_child(this.clockBox);
        row.add_child(this.mediaMarks);
        row.add_child(this.chargeBadge);
        container.add_child(row);

        // Everything in the pill is click-through until the notch is open.
        container.reactive = false;
        this.closedButton = new St.Button({style_class: 'notch-closed-button', reactive: false, child: container});
        this.closedButton.connect('clicked', () => this.setExpanded(!this.expanded));
        return this.closedButton;
    }

    _buildContent() {
        const content = box(true, 'notch-content', 0);
        content.x_expand = true;
        content.y_expand = true;

        const header = box(false, 'notch-header', 8);
        header.x_expand = true;
        this.headerSpacer = box(false, 'notch-header-spacer', 0);
        this.tabsBar = box(false, 'notch-tabs', 2);
        this.tabsBar.x_align = Clutter.ActorAlign.CENTER;
        this.tabButtons = TABS.map((tab) => {
            const widget = button({
                iconName: tab.icon,
                text: tab.title,
                style: 'notch-tab',
                accessibleName: tab.title,
                onClick: () => this.selectTab(tab.id),
            });
            this.tabsBar.add_child(widget);
            return widget;
        });
        this.headerRight = box(false, 'notch-header-controls', 6);
        this.settingsButton = button({
            iconName: 'settings-sliders-symbolic',
            style: 'notch-icon-button notch-header-button',
            accessibleName: 'Notch settings',
            onClick: () => this.extension.openPreferences?.(),
        });
        this.closeButton = button({
            iconName: 'window-close-symbolic',
            style: 'notch-icon-button notch-header-button',
            accessibleName: 'Close notch',
            onClick: () => this.setExpanded(false),
        });
        this.headerRight.add_child(this.settingsButton);
        this.headerRight.add_child(this.closeButton);

        header.add_child(this.headerSpacer);
        header.add_child(this.tabsBar);
        header.add_child(this.headerRight);
        content.add_child(header);

        this.pageStack = new St.Widget({layout_manager: new Clutter.BinLayout(), y_expand: true, x_expand: true});
        this.psd = new PsdPage({
            settings: this.settings,
            relayout: () => this._reposition(),
            reveal: () => this.selectTab('chat'),
        });
        this.pages = {
            home: this._buildHome(),
            chat: this.psd.page,
            media: this._buildMedia(),
            notifications: this._buildAlerts(),
            system: this._buildSystem(),
        };
        for (const [id, page] of Object.entries(this.pages)) {
            page.x_expand = true;
            if (id === 'chat' || id === 'notifications') {
                page.y_expand = true;
                page.y_align = Clutter.ActorAlign.FILL;
            } else {
                page.y_expand = true;
                page.y_align = Clutter.ActorAlign.CENTER;
            }
            this.pageStack.add_child(page);
        }
        content.add_child(this.pageStack);

        this.statusBar = box(false, 'notch-status-bar', 6);
        this.statusBar.x_align = Clutter.ActorAlign.CENTER;
        this.statusBar.visible = false;
        this.statusLabel = wrapLabel('', 'notch-status');
        this.statusAction = null;
        this.statusButton = button({text: 'Retry', style: 'notch-small-button', onClick: () => this.statusAction?.()});
        this.statusButton.visible = false;
        this.statusBar.add_child(this.statusLabel);
        this.statusBar.add_child(this.statusButton);
        this.statusBar.add_child(button({
            iconName: 'window-close-symbolic',
            style: 'notch-icon-button',
            accessibleName: 'Dismiss message',
            onClick: () => this.clearStatus(),
        }));
        content.add_child(this.statusBar);
        return content;
    }

    _buildPeek() {
        const container = box(true, 'notch-peek', 6);
        container.x_align = Clutter.ActorAlign.CENTER;
        container.visible = false;
        this.peekTitle = label('', 'notch-peek-title');
        this.peekBody = label('', 'notch-peek-body');
        this.peekBody.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.peekActions = box(false, 'notch-actions-row', 6);
        const action = button({text: 'Open', style: 'notch-peek-action', onClick: () => this.setExpanded(true)});
        this.peekActions.add_child(action);
        container.add_child(this.peekTitle);
        container.add_child(this.peekBody);
        container.add_child(this.peekActions);
        return container;
    }

    // ── pages ───────────────────────────────────────────────────────────────
    _buildHome() {
        const page = box(true, 'notch-home-page', 2);
        page.x_align = Clutter.ActorAlign.CENTER;
        this.homeClock = label('', 'notch-home-clock');
        this.homeClock.x_align = Clutter.ActorAlign.CENTER;
        this.homeDate = label('', 'notch-home-date');
        this.homeDate.x_align = Clutter.ActorAlign.CENTER;
        page.add_child(this.homeClock);
        page.add_child(this.homeDate);
        this.homeStats = box(false, 'notch-actions-row', 8);
        this.homeStats.x_align = Clutter.ActorAlign.CENTER;
        page.add_child(this.homeStats);
        this.homeActions = box(false, 'notch-actions-row', 8);
        this.homeActions.x_align = Clutter.ActorAlign.CENTER;
        page.add_child(this.homeActions);
        return page;
    }

    _buildMedia() {
        const page = box(true, 'notch-media-page', 8);
        this.mediaCover = sourceIcon(null, 'audio-x-generic-symbolic', 72);
        this.mediaCover.x_align = Clutter.ActorAlign.CENTER;
        this.mediaTitle = label('Nothing playing', 'notch-media-title');
        this.mediaTitle.x_align = Clutter.ActorAlign.CENTER;
        this.mediaArtist = label('', 'notch-media-artist');
        this.mediaArtist.x_align = Clutter.ActorAlign.CENTER;
        this.mediaProgress = new St.Bin({style_class: 'notch-media-progress', x_expand: true});
        this.mediaTime = label('', 'notch-media-time');
        this.mediaControls = box(false, 'notch-media-controls', 10);
        this.mediaControls.x_align = Clutter.ActorAlign.CENTER;
        this.mediaButtons = {
            previous: button({iconName: 'media-skip-backward-symbolic', style: 'notch-icon-button', accessibleName: 'Previous track', onClick: () => this._mediaAction('Previous')}),
            play: button({iconName: 'media-playback-start-inverse-symbolic', style: 'notch-play', accessibleName: 'Play or pause', onClick: () => this._mediaAction('PlayPause')}),
            next: button({iconName: 'media-skip-forward-symbolic', style: 'notch-icon-button', accessibleName: 'Next track', onClick: () => this._mediaAction('Next')}),
        };
        for (const widget of Object.values(this.mediaButtons)) this.mediaControls.add_child(widget);

        page.add_child(this.mediaCover);
        page.add_child(this.mediaTitle);
        page.add_child(this.mediaArtist);
        page.add_child(this.mediaProgress);
        page.add_child(this.mediaTime);
        page.add_child(this.mediaControls);
        return page;
    }

    _buildAlerts() {
        const page = box(true, 'notch-page', 6);
        const scroll = new St.ScrollView({
            style_class: 'notch-alerts-scroll',
            x_expand: true,
            y_expand: true,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this.alertsList = box(true, 'notch-list', 6);
        this.alertsList.x_expand = true;
        scroll.child = this.alertsList;
        this.alertsEmpty = emptyState('No alerts', 'Notifications land here instead of covering your screen.',
            'notifications-disabled-symbolic');
        page.add_child(scroll);
        page.add_child(this.alertsEmpty);
        this.alertsScroll = scroll;
        return page;
    }

    _buildSystem() {
        const page = box(true, 'notch-page', 8);
        const header = box(false, 'notch-page-header', 8);
        const title = label('This machine', 'notch-page-title');
        title.x_expand = true;
        this.systemRefresh = button({text: 'refresh', style: 'notch-small-button', onClick: () => this._sampleSystem(true)});
        header.add_child(title);
        header.add_child(this.systemRefresh);
        this.statsGrid = box(true, 'notch-stats-grid', 8);
        this.statCards = {};
        for (const [key, text] of [['cpu', 'CPU'], ['memory', 'Memory'], ['network', 'Network'], ['disk', 'Disk']]) {
            const card = box(true, 'notch-stat-card', 2);
            const value = label('—', 'notch-stat-value');
            const name = label(text, 'notch-stat-label');
            const detail = label('', 'notch-stat-detail');
            card.add_child(value);
            card.add_child(name);
            card.add_child(detail);
            this.statsGrid.add_child(card);
            this.statCards[key] = {card, value, name, detail};
        }
        page.add_child(header);
        page.add_child(this.statsGrid);
        return page;
    }

    // ── settings & loops ────────────────────────────────────────────────────
    _connectSettings() {
        this.settingsIds = [];
        const on = (key, callback) => {
            const id = this.settings.connect(`changed::${key}`, callback);
            this.settingsIds.push(id);
        };
        for (const key of ['collapsed-width', 'collapsed-height', 'expanded-width', 'expanded-height',
            'placement', 'floating-margin', 'horizontal-offset', 'corner-radius', 'adaptive-corners',
            'match-panel-height', 'notch-scale'])
            on(key, () => this._reposition());

        on('psd-url', () => {
            this.psd?.client?.loadToken();
            this._evaluateVisibility();
        });
        on('psd-token', () => this.psd?.client?.loadToken());
        on('replace-panel-clock', () => this._applyPanelClock());
        on('idle-clock', () => this._updateClock());
        on('closed-media', () => this._updateClosedMedia());
        on('show-dnd', () => this._refreshHome());
        on('show-night-light', () => this._refreshHome());
        on('show-dark-mode', () => this._refreshHome());
        on('notifications-in-notch', () => this.notifications?.configure(
            this.settings.get_boolean('notifications-in-notch'),
            this.settings.get_boolean('auto-open-notifications')));
        on('hide-on-fullscreen', () => this._evaluateVisibility());
        on('hide-in-overview', () => this._evaluateVisibility());
        on('reserve-space', () => this._applyGeometry());
    }

    _installDbusProbe() {
        // The notifications bridge wraps the real tray; InjectionManager puts it
        // back exactly as it was on disable.
        this.injections = new InjectionManager();
        this.notifications = new NotificationBridge({
            tray: Main.messageTray,
            injections: this.injections,
            canHandle: () => this.settings.get_boolean('notifications-in-notch') && this.allowed,
            onActive: (notification) => this._onNotification(notification),
            onFallback: () => {},
        });
        this.notifications.configure(this.settings.get_boolean('notifications-in-notch'),
            this.settings.get_boolean('auto-open-notifications'));
    }

    _startLoops() {
        this._every(CLOCK_MS, 'clock', () => this._updateClock());
        this._updateClock();
        this._every(MEDIA_POLL_MS, 'media', () => this._sampleMedia());
        this._every(SYSTEM_POLL_MS, 'system', () => this._sampleSystem());
        this._every(EQ_MS, 'eq', () => this._stepEqualizer());
    }

    _every(ms, name, callback) {
        this._cancelTimer(name);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (this.dead) return GLib.SOURCE_REMOVE;
            callback();
            return GLib.SOURCE_CONTINUE;
        });
        this.timerIds = this.timerIds ?? new Map();
        this.timerIds.set(name, id);
        this.timers.add(id);
    }

    _after(ms, name, callback) {
        this._cancelTimer(name);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), () => {
            this.timers.delete(id);
            this.timerIds?.delete(name);
            if (!this.dead) callback();
            return GLib.SOURCE_REMOVE;
        });
        this.timerIds = this.timerIds ?? new Map();
        this.timerIds.set(name, id);
        this.timers.add(id);
    }

    _cancelTimer(name) {
        const id = this.timerIds?.get(name);
        if (id) {
            GLib.source_remove(id);
            this.timerIds.delete(name);
            this.timers.delete(id);
        }
    }

    // ── state ───────────────────────────────────────────────────────────────
    toggle() {
        this.setExpanded(!this.expanded);
    }

    setExpanded(expanded, {immediate = false} = {}) {
        const next = Boolean(expanded);
        if (!this.allowed && next) return;
        this.expanded = next;
        this.mode = next ? 'open' : 'closed';
        this.surface.reactive = next;
        this.closedButton.reactive = !next;
        this.closed.visible = !next;
        this.content.visible = next;
        this.peek.visible = false;

        if (next) {
            this._cancelTimer('autoHide');
            this._refreshAll();
            if (this.tab === 'chat') this.psd?.activate();
        } else {
            this._cancelTimer('hover');
            this.psd?.deactivate();
            this.clearStatus();
            this._scheduleAutoClose();
        }
        this._applyPanelClock();
        this._animate({immediate});
    }

    _scheduleAutoClose() {
        const ms = this.settings.get_int('auto-hide-ms');
        if (ms > 0 && this.expanded && !this.hovered) {
            this._after(ms, 'autoHide', () => {
                if (this.expanded && !this.hovered) this.setExpanded(false);
            });
        }
    }

    selectTab(id, {focus = true} = {}) {
        if (!this.pages[id]) return;
        const previous = this.tab;
        this.tab = id;
        for (const [key, page] of Object.entries(this.pages)) page.visible = key === id;
        const layout = headerLayout(this._contentWidth(), 1);
        this.tabButtons.forEach((widget, index) => {
            const active = TABS[index].id === id;
            widget.style_class = `notch-tab${active ? ' notch-tab-active' : ''}${layout.ultra ? ' notch-tab-ultra' : ''}`;
            if (widget._notchLabel) widget._notchLabel.visible = layout.showLabels && !layout.ultra;
        });
        if (previous !== id) {
            if (previous === 'chat') this.psd?.deactivate();
            if (id === 'chat' && this.expanded && focus) this.psd?.activate();
            if (id === 'notifications') this._renderAlerts();
            if (id === 'system') this._sampleSystem(true);
        }
        this._reposition();
    }

    _contentWidth() {
        const width = this.geometry.current.width;
        return Math.max(80, Math.min(width, this.settings.get_int('expanded-width')));
    }

    // ── layout & motion ─────────────────────────────────────────────────────
    _target(extra = {}) {
        const monitor = this.monitor ?? this._monitor();
        return notchGeometry(monitor, this._options(extra), this.expanded, this.mode);
    }

    _applyGeometry(geometry = this.geometry.current) {
        if (this.dead || !this.actor) return;
        const rect = geometry;
        this.actor.set_position(Math.round(rect.x), Math.round(rect.y));
        this.actor.set_size(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
        const style = `border-radius: ${Math.round(rect.topRadius)}px ${Math.round(rect.topRadius)}px ` +
            `${Math.round(rect.bottomRadius)}px ${Math.round(rect.bottomRadius)}px;`;
        this.surface.style = style;
        this._applyHeader();
        this.closed.opacity = this.expanded ? 0 : 255;
        this.content.opacity = this.expanded ? 255 : 0;
    }

    _applyHeader() {
        const layout = headerLayout(this._contentWidth(), 1);
        this.tabsBar.style = `spacing: ${layout.spacing}px;`;
        this.headerSpacer.set_size(layout.mode === 'labels' ? 76 : 12, -1);
        this.headerRight.visible = layout.showSettings;
        this.settingsButton.visible = layout.showSettings;
        this.closeButton.style_class = `notch-icon-button ${layout.ultra ? 'notch-header-button-ultra' : 'notch-header-button'}`;
        this.tabButtons.forEach((widget) => {
            widget.set_size(layout.tabWidth, -1);
            if (widget._notchLabel) widget._notchLabel.visible = layout.showLabels;
            widget.accessible_name = TABS[this.tabButtons.indexOf(widget)]?.title ?? '';
        });
        const columns = statColumns(this._contentWidth());
        this.statsGrid.vertical = columns === 1;
    }

    _animate({immediate = false} = {}) {
        const target = this._target();
        const reduced = !this.settings.get_boolean('animations');
        if (immediate || reduced) {
            this.geometry.snap(target);
            this._applyGeometry();
            return;
        }
        this._cancelTimer('frame');
        const profile = this.expanded ? SPRING_PROFILES.open : SPRING_PROFILES.close;
        this.geometry.setTarget(target, profile);
        const start = GLib.get_monotonic_time();
        let last = start;
        const tick = () => {
            const now = GLib.get_monotonic_time();
            const dt = Math.min(0.05, (now - last) / 1e6);
            last = now;
            this.geometry.step(dt);
            this._applyGeometry();
            if (this.geometry.settled || now - start > 1.2e6) {
                this.geometry.snap(target);
                this._applyGeometry();
                this.timerIds?.delete('frame');
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };
        const id = GLib.timeout_add(GLib.PRIORITY_HIGH, 16, tick);
        this.timerIds = this.timerIds ?? new Map();
        this.timerIds.set('frame', id);
        this.timers.add(id);
    }

    _reposition() {
        if (this.dead) return;
        this.monitor = this._monitor();
        this._applyGeometry();
        this._animate();
    }

    _applyPanelClock() {
        const replace = this.settings.get_boolean('replace-panel-clock');
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        if (!dateMenu) return;
        // While the notch is closed it *is* the clock, so the panel's own clock
        // would show it twice. Open, both are visible again.
        dateMenu.visible = replace ? this.expanded : true;
    }

    _evaluateVisibility() {
        if (this.dead) return;
        let allowed = true;
        if (this.settings.get_boolean('hide-on-fullscreen') &&
            global.display.get_focus_window?.()?.is_fullscreen?.())
            allowed = false;
        if (this.settings.get_boolean('hide-in-overview') && Main.overview?.visible)
            allowed = false;
        this.allowed = allowed;
        this.actor.visible = allowed;
        if (!allowed && this.expanded) this.setExpanded(false, {immediate: true});
    }

    // ── clock, media, system ────────────────────────────────────────────────
    _updateClock() {
        const now = GLib.DateTime.new_now_local();
        const time = now.format('%H:%M') ?? '';
        setText(this.clockLabel, this._closedText(time));
        setText(this.homeClock, time);
        setText(this.homeDate, now.format('%A %-d %B') ?? '');
        if (this.psd?.lastState === 'streaming') {
            this.liveBars.visible = true;
            this.mediaMarks.visible = false;
        }
    }

    /**
     * What the closed pill shows: live work first, then media, then the clock.
     * The clock is never lost — it is the fallback.
     */
    _closedText(clockText) {
        if (this.psd?.busy) {
            this.externalStatus = null;
            return 'PSD working…';
        }
        if (this.externalStatus?.until > Date.now() && this.externalStatus.text) return this.externalStatus.text;
        if (this.media?.title && this.settings.get_boolean('closed-media')) return this.media.title;
        return this.settings.get_boolean('idle-clock') ? clockText : '';
    }

    _stepEqualizer() {
        if (!this.liveBars.visible) return;
        const levels = visualizerLevels(this.eqStep++);
        this.liveBarActors.forEach((bar, index) => {
            const height = 4 + levels[index] * 12;
            bar.set_size(2, Math.round(height));
        });
    }

    async _sampleMedia() {
        if (this.dead) return;
        try {
            const proxy = await this._mediaProxy();
            if (!proxy) {
                this.media = null;
                this._renderMedia();
                return;
            }
            const [metadataVariant, statusVariant] = proxy.call_sync('org.freedesktop.DBus.Properties.GetAll',
                new GLib.Variant('(s)', [proxy.get_interface_name?.() ?? 'org.mpris.MediaPlayer2.Player']),
                Gio.DBusCallFlags.NONE, 800, null).deepUnpack();
            const metadata = mediaMetadata(metadataVariant['Metadata'] ?? {});
            this.media = {
                title: metadata.title,
                artist: metadata.artist,
                status: statusVariant?.PlaybackStatus ?? metadata.status ?? 'Stopped',
                lengthUs: metadata.lengthUs,
                positionUs: (statusVariant?.Position ?? 0),
            };
        } catch (error) {
            this.media = this.media?.title ? this.media : null;
        }
        this._renderMedia();
        this._updateClosedMedia();
    }

    /** The first MPRIS player that is actually playing, else the first one. */
    async _mediaProxy() {
        const names = Gio.DBus.session.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, 800, null).deepUnpack()[0] ?? [];
        const players = names.filter((name) => name.startsWith('org.mpris.MediaPlayer2.'));
        let fallback = null;
        for (const name of players) {
            try {
                const proxy = Gio.DBusProxy.new_sync(Gio.DBus.session, Gio.DBusProxyFlags.NONE, null,
                    name, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player', null);
                const status = proxy.get_cached_property('PlaybackStatus')?.deepUnpack?.() ?? '';
                if (status === 'Playing') return proxy;
                fallback = fallback ?? proxy;
            } catch {
                /* player went away */
            }
        }
        return fallback;
    }

    _renderMedia() {
        const media = this.media;
        setText(this.mediaTitle, mediaDisplayTitle(media));
        setText(this.mediaArtist, mediaDisplayArtist(media));
        setText(this.mediaTime, media?.lengthUs
            ? `${formatTime(media.positionUs ?? 0)} / ${formatTime(media.lengthUs)}` : '');
        const playing = media?.status === 'Playing';
        setIconSource(this.mediaButtons.play._notchIcon, null,
            playing ? 'media-playback-pause-inverse-symbolic' : 'media-playback-start-inverse-symbolic');
        this.mediaButtons.play.accessible_name = playing ? 'Pause' : 'Play';
        setSensitive(this.mediaButtons.play, Boolean(media));
        setSensitive(this.mediaButtons.previous, Boolean(media));
        setSensitive(this.mediaButtons.next, Boolean(media));
    }

    async _mediaAction(action) {
        try {
            const proxy = await this._mediaProxy();
            if (!proxy) return;
            proxy.call_sync(action === 'PlayPause' ? 'PlayPause' : action, null,
                Gio.DBusCallFlags.NONE, 800, null);
            this._sampleMedia();
        } catch (error) {
            this.showStatus(mediaErrorMessage(error.message), {action: () => this._mediaAction(action)});
        }
    }

    _updateClosedMedia() {
        const show = this.settings.get_boolean('closed-media') && Boolean(this.media?.title);
        this.mediaMarks.visible = Boolean(show && this.settings.get_boolean('idle-clock'));
        this._updateClock();
    }

    _sampleSystem(force = false) {
        if (this.dead) return;
        try {
            const cpuText = Shell.get_file_contents_utf8_sync('/proc/stat');
            const memoryText = Shell.get_file_contents_utf8_sync('/proc/meminfo');
            const netText = Shell.get_file_contents_utf8_sync('/proc/net/dev');

            const cpu = cpuSample(cpuText, this.previousRaw.cpu);
            this.previousRaw.cpu = cpu.raw;
            const memory = memorySample(memoryText);

            const now = GLib.get_monotonic_time() / 1e6;
            const elapsed = this.previousRaw.netAt ? now - this.previousRaw.netAt : 0;
            const net = networkSample(netText, this.previousRaw.net, elapsed);
            this.previousRaw.net = net.raw;
            this.previousRaw.netAt = now;

            this.system = {cpu: cpu.percent, memory, net};
            this._renderSystem();
            if (force) this.showStatus('Updated', {temporary: 1200});
        } catch (error) {
            this.showStatus('System stats are unavailable.', {});
        }
    }

    _renderSystem() {
        const system = this.system;
        if (!system) return;
        const set = (key, value, detail) => {
            setText(this.statCards[key].value, value);
            setText(this.statCards[key].detail, detail ?? '');
        };
        set('cpu', system.cpu === null || system.cpu === undefined ? '—' : `${Math.round(system.cpu)}%`, 'processor');
        set('memory', system.memory?.percent === null || system.memory?.percent === undefined
            ? '—' : `${Math.round(system.memory.percent)}%`,
        system.memory?.used ? `${formatBytes(system.memory.used)} used` : '');
        set('network', system.net?.download === null || system.net?.download === undefined
            ? '—' : formatBytes(system.net.download, '/s'),
        system.net?.upload ? `${formatBytes(system.net.upload, '/s')} up` : '');
        set('disk', '—', '');
        this._refreshHome();
    }

    _refreshHome() {
        if (!this.homeStats) return;
        this.homeStats.destroy_all_children();
        const system = this.system;
        if (system) {
            const chip = (text) => {
                const widget = label(text, 'notch-stat-value');
                this.homeStats.add_child(widget);
                return widget;
            };
            chip(system.cpu === null || system.cpu === undefined ? 'CPU —' : `CPU ${Math.round(system.cpu)}%`);
            chip(system.memory?.percent === null || system.memory?.percent === undefined
                ? 'RAM —' : `RAM ${Math.round(system.memory.percent)}%`);
        }
        this.homeActions.destroy_all_children();
        this.homeActions.add_child(button({text: 'Ask PSD', style: 'notch-action notch-action-active',
            onClick: () => { this.setExpanded(true); this.selectTab('chat'); }}));
        if (this.settings.get_boolean('show-dark-mode'))
            this.homeActions.add_child(button({text: 'Dark mode', style: 'notch-action',
                onClick: () => this._toggleDarkMode()}));
        if (this.settings.get_boolean('show-night-light'))
            this.homeActions.add_child(button({text: 'Night light', style: 'notch-action',
                onClick: () => this._toggleNightLight()}));
    }

    _toggleDarkMode() {
        try {
            const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const dark = settings.get_string('color-scheme') === 'prefer-dark';
            settings.set_string('color-scheme', dark ? 'default' : 'prefer-dark');
            this.showStatus(dark ? 'Light mode' : 'Dark mode', {temporary: 1200});
        } catch {
            this.showStatus('This GNOME cannot switch colour schemes.', {});
        }
    }

    _toggleNightLight() {
        try {
            const settings = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'});
            const on = settings.get_boolean('night-light-enabled');
            settings.set_boolean('night-light-enabled', !on);
            this.showStatus(on ? 'Night light off' : 'Night light on', {temporary: 1200});
        } catch {
            this.showStatus('Night light is not available here.', {});
        }
    }

    // ── notifications ───────────────────────────────────────────────────────
    _onNotification(notification) {
        this.notificationCount = countNotifications(Main.messageTray?.getSources?.() ?? []);
        this.unreadDot.visible = this.notificationCount > 0;
        const title = plainText(notification.title ?? 'Notification');
        const body = previewText(notification.body ?? '', 160);
        const lines = [{title, body: body.text}];

        this._renderAlerts([{title, body: body.text}]);
        if (this.settings.get_boolean('auto-open-notifications')) {
            this.setExpanded(true);
            this.selectTab('notifications');
        } else {
            this._showPeek(title, body.text);
        }
    }

    _renderAlerts(extra = []) {
        const sources = Main.messageTray?.getSources?.() ?? [];
        const items = [];
        for (const source of sources)
            for (const notification of source.notifications ?? [])
                items.push({
                    title: plainText(notification.title ?? ''),
                    body: previewText(notification.body ?? '', 180).text,
                });
        const all = [...extra, ...items];
        this.alertsList.destroy_all_children();
        this.alertsEmpty.visible = all.length === 0;
        this.alertsScroll.visible = all.length > 0;
        for (const item of all.slice(0, 40)) this.alertsList.add_child(this._notificationCard(item));
        setText(this.unreadDot, '');
        this.unreadDot.visible = all.length > 0;
    }

    _notificationCard({title, body}) {
        const card = box(true, 'notch-notification', 3);
        const top = box(false, 'notch-notification-top', 6);
        const name = label(title || 'Notification', 'notch-notification-title');
        name.x_expand = true;
        const dismiss = button({
            iconName: 'window-close-symbolic',
            style: 'notch-icon-button',
            accessibleName: 'Dismiss',
            onClick: () => { card.destroy(); this._renderAlerts(); },
        });
        top.add_child(name);
        top.add_child(dismiss);
        card.add_child(top);
        if (body) card.add_child(wrapLabel(body, 'notch-notification-body'));
        return card;
    }

    _showPeek(title, body) {
        setText(this.peekTitle, title);
        setText(this.peekBody, body);
        this.peek.visible = true;
        this.mode = 'peek';
        this._animate();
        this._after(this.settings.get_int('peek-duration-ms'), 'peek', () => {
            if (this.mode !== 'peek') return;
            this.peek.visible = false;
            this.mode = this.expanded ? 'open' : 'closed';
            this._animate();
        });
    }

    // ── agent integration ───────────────────────────────────────────────────
    /** D-Bus PsdMessage: a card, a live status, a token stream or a snapshot. */
    receivePsd(raw) {
        if (this.dead) return;
        let message = raw;
        if (typeof raw === 'string') {
            try {
                message = JSON.parse(raw);
            } catch {
                return;
            }
        }
        if (!message || typeof message !== 'object') return;
        switch (message.kind) {
        case 'card':
            this.psd?.receive({title: message.title, body: message.body});
            this._showPeek(message.title ?? 'PSD', message.body ?? '');
            if (message.open) this.openPsd(message.tab || 'chat');
            break;
        case 'status':
            this.externalStatus = message.state === 'working' || message.state === 'tool'
                ? {text: message.text ?? 'PSD working…', until: Date.now() + 30000}
                : null;
            this._updateClock();
            break;
        case 'token':
            this.psd?.receive({title: 'PSD', body: message.text ?? ''});
            break;
        case 'system':
            this._sampleSystem();
            break;
        case 'dnd':
        case 'theme':
            this._refreshHome();
            break;
        default:
            break;
        }
    }

    openPsd(tab = 'chat') {
        this.setExpanded(true);
        this.selectTab(tab);
    }

    psdState() {
        return JSON.stringify({
            ...(this.psd?.state() ?? {state: 'idle'}),
            expanded: this.expanded,
            tab: this.tab,
            notifications: this.notificationCount,
        });
    }

    state() {
        return JSON.stringify({expanded: this.expanded, tab: this.tab, mode: this.mode});
    }

    // ── chrome ──────────────────────────────────────────────────────────────
    showStatus(text, {action = null, temporary = 0, error = false} = {}) {
        setText(this.statusLabel, text);
        this.statusAction = action;
        this.statusButton.visible = Boolean(action);
        this.statusBar.visible = true;
        this.statusBar.style_class = `notch-status-bar${error ? ' notch-status-error' : ''}`;
        if (temporary > 0) this._after(temporary, 'status', () => this.clearStatus());
    }

    clearStatus() {
        this.statusBar.visible = false;
        this.statusAction = null;
    }

    _refreshAll() {
        this._updateClock();
        this._sampleMedia();
        this._sampleSystem();
        this._refreshHome();
        this._renderAlerts();
        this.psd?._refreshStatus?.();
        this.selectTab(this.tab, {focus: false});
    }

    destroy() {
        if (this.dead) return;
        this.dead = true;
        for (const id of this.timers) GLib.source_remove(id);
        this.timers.clear();
        this.timerIds?.clear();
        for (const id of this.settingsIds ?? []) this.settings.disconnect(id);
        this.settingsIds = [];
        this.notifications?.destroy();
        this.injections?.clear();
        this.psd?.destroy();
        this.actor?.remove_all_transitions?.();
        try {
            Main.layoutManager.removeChrome(this.actor);
        } catch {
            /* already removed */
        }
        global.display.disconnectObject(this.actor);
        global.window_manager.disconnectObject(this.actor);
        Main.layoutManager.disconnectObject(this.actor);
        this.actor?.destroy();
        this.actor = null;
    }
}

// notifications.js — catch ordinary banners and show them *in* the notch.
//
// GNOME draws notification banners from Main.messageTray._showNotification().
// We wrap that method instead of reimplementing the tray: the real queue,
// urgency handling, sounds and acking all keep working. Critical and
// time-sensitive notifications are handed straight back to the Shell, because
// interrupting the owner is exactly what they are for.

/**
 * Decide whether a notification belongs in the notch.
 * Ordinary urgency only. Anything urgent, already-acknowledged, or from a
 * source the owner muted stays with the Shell.
 */
export function shouldIntercept(notification) {
    if (!notification) return false;
    if (notification.acknowledged) return false;
    // Urgency: 0 low, 1 normal, 2 critical.
    if ((notification.urgency ?? 1) !== 1) return false;
    return true;
}

export class NotificationBridge {
    /**
     * @param {object} options
     * @param {object} options.tray Main.messageTray
     * @param {object} options.injections {overrideMethod, restoreMethod}
     * @param {Function} [options.canHandle] extra gate, e.g. fullscreen check
     * @param {Function} [options.onActive] called with each intercepted notification
     * @param {Function} [options.onFallback] called when we hand one back
     */
    constructor({tray, injections, canHandle = () => true, onActive = () => {}, onFallback = () => {}}) {
        this.tray = tray;
        this.injections = injections;
        this.canHandle = canHandle;
        this.onActive = onActive;
        this.onFallback = onFallback;
        this.active = false;
        this.autoOpen = false;
        this._original = null;
    }

    /** Turn interception on/off without re-wrapping an already-wrapped method. */
    configure(active, autoOpen = false) {
        this.active = Boolean(active);
        this.autoOpen = Boolean(autoOpen);
        if (this.active && !this._original) this._install();
        if (!this.active && this._original) this._restore();
    }

    _install() {
        // InjectionManager.overrideMethod(object, name, createMethod) takes a
        // *factory*: it calls createMethod(original) and installs the result.
        this.injections.overrideMethod(this.tray, '_showNotification', (original) => {
            this._original = original;
            const bridge = this;
            return function showNotificationThroughNotch(...args) {
                // Anything we cannot take, or any state we do not understand, is
                // the Shell's problem — never swallow a notification.
                try {
                    if (bridge.active && bridge._take()) return undefined;
                } catch (error) {
                    // Fall through to the Shell so a bridge bug cannot lose a banner.
                    globalThis.log?.('notch: notification bridge error', error);
                }
                bridge.onFallback();
                return original.apply(this, args);
            };
        });
    }

    _restore() {
        if (!this._original) return;
        this.injections.restoreMethod(this.tray, '_showNotification', this._original);
        this._original = null;
    }

    _take() {
        const queue = this.tray._notificationQueue ?? [];
        const notification = queue[0];
        if (!notification) return false;
        if (!shouldIntercept(notification) || !this.canHandle(notification)) return false;
        queue.shift();
        // Match the Shell: a shown banner is acknowledged and audible unless the
        // notification asked for silence.
        notification.acknowledged = true;
        try {
            notification.playSound?.();
        } catch {
            /* sound is best-effort */
        }
        this.onActive(notification, {autoOpen: this.autoOpen});
        return true;
    }

    destroy() {
        this.active = false;
        this._restore();
        this.tray = null;
    }
}

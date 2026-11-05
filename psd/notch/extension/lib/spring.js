// spring.js — the motion. A critically-tuned damped spring, integrated with a
// fixed step so the result never depends on frame pacing.
//
// Two profiles exist because opening and closing are not the same gesture:
// opening is quick and slightly springy, closing is softer and never bounces.

export const SPRING_PROFILES = Object.freeze({
    // dt-independent: stiffness/damping chosen for a ~420 ms settle with a
    // visible but polite overshoot.
    open: Object.freeze({stiffness: 620, damping: 30, mass: 1}),
    close: Object.freeze({stiffness: 560, damping: 40, mass: 1}),
});

const STEP = 1 / 120;
const REST_EPSILON = 0.01;
const REST_VELOCITY = 5;

export function easeOutCubic(t) {
    const x = Math.min(1, Math.max(0, t));
    return 1 - (1 - x) ** 3;
}

/** One scalar on a spring. */
export class SpringValue {
    constructor(value = 0, profile = SPRING_PROFILES.open) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
        this.profile = profile;
        this.settled = true;
    }

    setTarget(target, profile = null) {
        if (profile) this.profile = profile;
        if (target !== this.target) this.settled = false;
        this.target = target;
        return this;
    }

    /** Jump to a value with no motion (first layout, or reduced motion). */
    snap(value) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
        this.settled = true;
        return this;
    }

    /** Advance by `dt` seconds; internally sub-steps so motion stays stable. */
    step(dt) {
        if (this.settled) return this.value;
        let remaining = Math.min(0.1, Math.max(0, dt));
        while (remaining > 0) {
            const h = Math.min(STEP, remaining);
            remaining -= h;
            const {stiffness, damping, mass} = this.profile;
            const force = -stiffness * (this.value - this.target) - damping * this.velocity;
            this.velocity += (force / mass) * h;
            this.value += this.velocity * h;
        }
        if (Math.abs(this.value - this.target) < REST_EPSILON &&
            Math.abs(this.velocity) < REST_VELOCITY * 100) {
            this.value = this.target;
            this.velocity = 0;
            this.settled = true;
        }
        return this.value;
    }
}

/** A rect on four independent springs, so width and height can differ. */
export class SpringGeometry {
    constructor(initial = {x: 0, y: 0, width: 0, height: 0, topRadius: 0, bottomRadius: 0}) {
        this.keys = ['x', 'y', 'width', 'height', 'topRadius', 'bottomRadius'];
        this.values = {};
        for (const key of this.keys) this.values[key] = new SpringValue(initial[key] ?? 0);
    }

    get settled() {
        return this.keys.every((key) => this.values[key].settled);
    }

    get current() {
        const out = {};
        for (const key of this.keys) out[key] = this.values[key].value;
        return out;
    }

    setTarget(target, profile = SPRING_PROFILES.open) {
        for (const key of this.keys)
            if (target[key] !== undefined) this.values[key].setTarget(target[key], profile);
        return this;
    }

    snap(target) {
        for (const key of this.keys)
            if (target[key] !== undefined) this.values[key].snap(target[key]);
        return this;
    }

    step(dt) {
        for (const key of this.keys) this.values[key].step(dt);
        return this.current;
    }
}

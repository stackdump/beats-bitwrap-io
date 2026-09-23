// Replay a capture (as downloaded from calibrate.html) into a MockMIDIInput,
// preserving the original spacing. Timestamps are rebased onto "now" so the
// adapter sees a live-looking stream.

// Accepts a calibrate.html session ({steps: {id: [...]}}) or a bare array.
export function flattenCapture(json) {
    const msgs = Array.isArray(json) ? json : Object.values(json.steps || {}).flat();
    return msgs.filter((m) => Array.isArray(m.d) && typeof m.t === 'number').sort((a, b) => a.t - b.t);
}

export function replayCapture(input, msgs, { speed = 1, maxGapMs = 1500, now = () => performance.now() } = {}) {
    return new Promise((resolve) => {
        if (!msgs.length) return resolve(0);
        // Collapse the dead air between calibration steps.
        const rel = [0];
        for (let i = 1; i < msgs.length; i++) rel.push(rel[i - 1] + Math.min(maxGapMs, msgs[i].t - msgs[i - 1].t) / speed);
        const start = now();
        let i = 0;
        const pump = () => {
            const elapsed = now() - start;
            while (i < msgs.length && rel[i] <= elapsed) { input.receive(msgs[i].d, start + rel[i]); i++; }
            if (i >= msgs.length) return resolve(msgs.length);
            setTimeout(pump, Math.max(1, Math.min(8, rel[i] - elapsed)));
        };
        pump();
    });
}

// SVG jog wheel. Input and display are deliberately decoupled:
//
//   pointer  ->  JogWheelSim (the "hardware")            [only in mock mode]
//   display  <-  the MIDI message stream, via showTicks()/showTouch()
//
// The wheel you see turning is drawn from the messages, not from the mouse,
// so it moves in encoder-tick steps and shows exactly what the consumer was
// told. With a real controller the same display follows the real platter.
//
// Drag the inner platter = touch + rotate (scratch CC).
// Drag the outer ring    = rotate only   (bend CC).
// Hold Shift while dragging for the SHIFT layer. Let go mid-swing to flick.

const NS = 'http://www.w3.org/2000/svg';
const R_OUTER = 100;
const R_PLATTER = 76;

function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    parent?.appendChild(node);
    return node;
}

export function mountJogWheel(host, { sim = null, ticksPerRev }) {
    const svg = el('svg', { viewBox: '-110 -110 220 220', class: 'jog' }, host);
    const ring = el('circle', { r: (R_OUTER + R_PLATTER) / 2, class: 'jog-ring', 'stroke-width': R_OUTER - R_PLATTER }, svg);
    const spin = el('g', {}, svg);
    for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        el('line', {
            x1: Math.cos(a) * (R_PLATTER + 5), y1: Math.sin(a) * (R_PLATTER + 5),
            x2: Math.cos(a) * (R_OUTER - 5), y2: Math.sin(a) * (R_OUTER - 5),
            class: 'jog-knurl',
        }, spin);
    }
    const platter = el('circle', { r: R_PLATTER - 2, class: 'jog-platter' }, spin);
    el('line', { x1: 0, y1: -12, x2: 0, y2: -(R_PLATTER - 8), class: 'jog-marker' }, spin);
    el('circle', { r: 9, class: 'jog-hub' }, spin);

    let ticks = 0;
    function showTicks(delta) {
        ticks += delta;
        spin.setAttribute('transform', `rotate(${(ticks / ticksPerRev) * 360})`);
    }
    function showTouch(down) {
        platter.classList.toggle('touched', down);
    }

    if (sim) {
        let drag = null;
        const polar = (e) => {
            const box = svg.getBoundingClientRect();
            const x = e.clientX - (box.left + box.width / 2);
            const y = e.clientY - (box.top + box.height / 2);
            return { angle: Math.atan2(y, x), radius: Math.hypot(x, y) / (box.width / 220) };
        };

        svg.addEventListener('pointerdown', (e) => {
            const { angle, radius } = polar(e);
            if (radius > R_OUTER + 6) return;
            svg.setPointerCapture(e.pointerId);
            sim.shift = e.shiftKey;
            drag = { angle, t: e.timeStamp, omega: 0, onPlatter: radius <= R_PLATTER };
            sim.omega = 0; // a hand anywhere on the wheel stops a coast
            if (drag.onPlatter) sim.touch(true, e.timeStamp);
            ring.classList.toggle('held', !drag.onPlatter);
        });

        svg.addEventListener('pointermove', (e) => {
            if (!drag) return;
            // Coalesced events recover the pointer samples the browser merged
            // into this frame — several-fold better time resolution.
            const samples = e.getCoalescedEvents?.() ?? [];
            for (const s of samples.length ? samples : [e]) {
                const { angle } = polar(s);
                let d = angle - drag.angle;
                if (d > Math.PI) d -= Math.PI * 2;
                if (d < -Math.PI) d += Math.PI * 2;
                const t = Math.max(s.timeStamp, drag.t);
                const dt = (t - drag.t) / 1000;
                if (dt > 0) drag.omega += (d / dt - drag.omega) * 0.35;
                sim.rotate(d, drag.t, t);
                drag.angle = angle;
                drag.t = t;
            }
        });

        const end = (e) => {
            if (!drag) return;
            const idle = e.timeStamp - drag.t > 60; // hand stopped before letting go
            if (drag.onPlatter) sim.touch(false, e.timeStamp);
            sim.fling(idle ? 0 : drag.omega);
            ring.classList.remove('held');
            drag = null;
        };
        svg.addEventListener('pointerup', end);
        svg.addEventListener('pointercancel', end);

        const loop = (now) => { sim.step(now); requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
    }

    return { showTicks, showTouch };
}

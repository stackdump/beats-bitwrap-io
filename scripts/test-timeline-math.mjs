#!/usr/bin/env node
// Lane-view geometry (public/lib/viz/timeline-math.js): which way time flows
// and that a note's trail sits BEHIND its dot relative to the motion.
import { dotX, trailSpan, layoutDots, windowSec, FLOW } from '../public/lib/viz/timeline-math.js';

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

const w = 1000, win = 8;
check('window is one bar, floored at 2 s', windowSec(120) === 2 && windowSec(60) === 4 && windowSec(200) === 2 && windowSec(NaN) === 2);
check('a note that just sounded is at the playhead (right edge)', dotX(0, win, w) === w);
check('older notes are further left', dotX(2, win, w) < dotX(1, win, w) && dotX(win, win, w) === 0);

// Direction of motion: sample one note over time.
const evt = [{ t: 10 }];
const xs = [10, 10.5, 11, 12].map(now => layoutDots(evt, now, win, w)[0].x);
const dx = xs[1] - xs[0];
check('the dot moves right → left', xs.every((x, i) => i === 0 || x < xs[i - 1]), xs.map(Math.round).join(' → '));
check('FLOW agrees with the observed motion', Math.sign(dx) === FLOW);

// The trail is behind the dot: on the side opposite to the motion.
for (const now of [10.25, 11, 14, 17]) {
    const [d] = layoutDots(evt, now, win, w);
    const behind = Math.sign(d.trail.farEnd - d.trail.dotEnd) === -Math.sign(dx);
    check(`trail sits behind the dot at t+${(now - 10).toFixed(2)}s`, behind && d.trail.dotEnd === d.x && d.trail.x0 <= d.x && d.x <= d.trail.x1 && d.trail.farEnd > d.x,
        `dot ${d.x.toFixed(1)}, trail ${d.trail.x0.toFixed(1)}..${d.trail.x1.toFixed(1)}`);
}
const s = trailSpan(500, 20);
check('trailSpan: opaque end is at the dot, far end is toward the playhead', s.dotEnd === 500 && s.farEnd === 520 && s.x0 === 500 && s.x1 === 520);

// Notes still ahead of the audio clock are held back, not drawn past the playhead.
check('a note not yet sounding is not drawn', layoutDots([{ t: 11 }], 10, win, w).length === 0);
check('a note older than the window is dropped', layoutDots([{ t: 0 }], 9, win, w).length === 0);
// Constant scroll speed: independent of how many other events exist.
const crowd = Array.from({ length: 400 }, (_, i) => ({ t: 9 + i / 1000 }));
const a = layoutDots([...crowd, { t: 5, id: 'x' }], 10, win, w).find(d => d.evt.id === 'x').x;
const b = layoutDots([{ t: 5, id: 'x' }], 10, win, w)[0].x;
check('scroll speed does not depend on how many events are retained', a === b);

console.log(failures ? `${failures} failure(s)` : 'all ok');
process.exit(failures ? 1 : 0);

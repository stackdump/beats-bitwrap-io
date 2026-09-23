// Rehearse the hardware-day wizard against the simulated wheel:
//   (cd public && python3 -m http.server 8765) & node public/jog/e2e-calibrate.cdp.mjs
// Performs every step with real mouse drags, then checks the wizard measured
// the simulated device correctly, saved an override, and that demo.html loads it.
import assert from 'node:assert/strict';
import { launch, sleep } from './cdp.mjs';

const BASE = process.env.JOG_BASE || 'http://127.0.0.1:8765/jog/';
const page = await launch(BASE + 'calibrate.html?midi=mock');
const W = '.jog';
const startStop = () => page.click('#steps li.current button');
const next = () => page.click('#steps li.current button.ghost');
const SHIFT = 8;

const moves = [
    async () => { for (let i = 0; i < 3; i++) { await page.arc(W, 0.4, 0, 0.01, 60); await sleep(80); } },
    () => page.arc(W, 0.4, -90, 270, 1600),
    () => page.arc(W, 0.4, -90, -450, 1600),
    () => page.arc(W, 0.88, -90, 270, 1200),
    async () => { await page.arc(W, 0.4, 0, 400, 260); await sleep(2500); },
    () => page.arc(W, 0.4, 0, 60, 300, { modifiers: SHIFT }),
    () => page.arc(W, 0.4, 0, 60, 300),
    async () => { await page.click('#deck-b'); await page.arc(W, 0.4, 0, 60, 300); },
];

for (let i = 0; i < moves.length; i++) {
    await startStop();
    await sleep(100);
    await moves[i]();
    await sleep(150);
    await startStop();
    await sleep(100);
    if (i < moves.length - 1) await next();
}

const override = JSON.parse(await page.ev(`document.getElementById('override').textContent`));
const warns = await page.ev(`[...document.querySelectorAll('.warn')].map(w => w.textContent)`);
console.log('override', JSON.stringify(override));
console.log('warnings', warns);
assert.deepEqual(override.decks, { A: 1, B: 2 });
assert.deepEqual(override.touch, { note: 8, onVelocity: 127, releaseAsNoteOff: false });
assert.equal(override.scratchCC, 0x0A);
assert.equal(override.bendCC, 0x09);
assert.equal(override.encoding, 'twos');
assert.equal(override.shiftChannelOffset, 3);
assert.ok(Math.abs(override.ticksPerRev - 248) <= 4, `ticksPerRev ${override.ticksPerRev}`);

await page.click('#save');
// same tab, same origin => demo.html sees the saved override
await page.send('Page.navigate', { url: BASE + 'demo.html' });
await sleep(1200);
const src = await page.ev(`document.getElementById('source').textContent`);
console.log('demo source:', src);
assert.match(src, /calibrated \(.*ticksPerRev/);
await page.ev(`localStorage.removeItem('jog-profile-override')`);
assert.deepEqual(page.errors, [], 'page errors');
console.log('OK');
process.exit(0);

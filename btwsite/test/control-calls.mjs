// control-calls.mjs: every control command BtwRun.service() hands the page, on a fake 25 ms clock, between two bars.
//   node btwsite/test/control-calls.mjs <wasm dir: btw.js + btw_bg.wasm> <file.btw> <fromBar> <toBar>
// What found the riser bug: at a section line the old ramps last values came after the section own `filter off`.
import fs from 'node:fs';
const [dir, file, fromBar = '0', toBar = '999'] = process.argv.slice(2);
const glue = await import(`${dir}/btw.js`);
glue.initSync({ module: fs.readFileSync(`${dir}/btw_bg.wasm`) });
const run = new glue.BtwRun();
const ev = JSON.parse(run.eval(fs.readFileSync(file, 'utf8')));
if (!ev.ok) { console.error(ev.diagnostics); process.exit(2); }
const bpm = ev.tempo || 120;
let playing = { A: false, B: false }, t = 0;
for (;;) {
  const beat = t * bpm / 60, bar = beat / 4;
  const grid = (playing.A || playing.B) ? { deck: 'A', beat, bpm, playing: { ...playing } } : null;
  for (const c of JSON.parse(run.service(JSON.stringify(grid)))) {
    if (c.op === 'play') playing[c.deck] = !!c.on;
    if (c.op === 'load_net' || c.op === 'sound') continue;
    if (bar >= +fromBar && bar <= +toBar) console.log(bar.toFixed(3), JSON.stringify(c.params || c));
  }
  if (bar > +toBar) break;
  t += 0.025;
}

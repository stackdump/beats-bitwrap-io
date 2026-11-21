#!/usr/bin/env node
// Play one CID through the stream source in headless Chrome and log what the player does: state, seconds ahead,
// underruns, stall, and the stack of every app.stop(). node btwsite/test/stream-probe.mjs <base> <cid> [seconds] [source]
import { launch, sleep } from './cdp.mjs';
const [base = 'https://beatscript.app', cid, secs = '30', src = 'stream'] = process.argv.slice(2);
const page = await launch({});
await page.goto(`${base}/${process.env.QS ? '?' + process.env.QS : ''}#${cid}`);
await page.eval('(async()=>{ for (let i=0;i<400 && !(window.__btw);i++) await new Promise(r=>setTimeout(r,50)); await window.__btw.ready; return true })()', true);
for (let i = 0; i < 100; i++) { if (await page.eval(`!!(window.__btw.app.report && window.__btw.app.report.cid === ${JSON.stringify(cid)})`)) break; await sleep(100); }
await page.eval(`(()=>{ const a = window.__btw.app; window.__log = []; const st = a.stop.bind(a);
  a.stop = function(){ window.__log.push({t: performance.now()/1000, stop: new Error().stack.split('\\n').slice(1,6).join(' | ')}); return st(); };
  window.__lt=[]; try{ new PerformanceObserver(l=>{for(const e of l.getEntries()) window.__lt.push([+(e.startTime/1000).toFixed(1), Math.round(e.duration), (e.scripts||[]).slice(0,3).map(x=>(x.sourceFunctionName||'')+'@'+(x.sourceURL||'').split('/').pop()+':'+Math.round(x.duration)).join(',')])}).observe({type:'long-animation-frame',buffered:true}); }catch(e){}
  a.sourcePref = ${JSON.stringify(src)}; a.ensureAudio(); return a.play('load'); })()`, true);
const t0 = Date.now();
let last = '';
while (Date.now() - t0 < Number(secs) * 1000) {
  const s = await page.eval(`(()=>{ const a = window.__btw.app, p = a.player; const ctx = a.ctx;
    return JSON.stringify({ t: +((performance.now())/1000).toFixed(1), ctx: ctx && ctx.state, ct: ctx && +ctx.currentTime.toFixed(2), playing: a.isPlaying(), src: a.driver && a.driver.src && a.driver.src.kind,
      st: p ? p.state : null, ahead: p ? +p.buffered().toFixed(1) : null, rec: p ? +p.received.toFixed(1) : null, under: p ? p.underruns : null, stall: p ? +p.stall.toFixed(3) : null, done: p ? p.done : null,
      status: (document.getElementById('st-long')||{}).textContent, log: window.__log.splice(0), lt: window.__lt.splice(0).filter(x=>x[1]>150) }); })()`);
  const o = JSON.parse(s);
  const key = `${o.st}|${o.under}|${o.playing}|${o.status}`;
  if (key !== last || o.log.length || o.lt.length) { console.log(s); last = key; }
  await sleep(250);
}
console.log('engine slow blocks:', await page.eval(`JSON.stringify((()=>{ const e = window.__btw.app.engine; const s = e && e.stats ? e.stats.slow : []; return { n: s.length, worst: s.slice().sort((a,b)=>b.ms-a.ms).slice(0,8) }; })())`));
console.log('logs:', JSON.stringify(page.logs.slice(-20)));
await page.close();
process.exit(0);

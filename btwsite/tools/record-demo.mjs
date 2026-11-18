#!/usr/bin/env node
// Deterministic demo recorder for btw.bitwrap.io: no screen capture, no system audio, no wall clock.
//
//   node btwsite/tools/record-demo.mjs --server http://127.0.0.1:18097 --btwd target/release/btwd \
//        --cid z4EBG9jB3vwMeCJNSp8WJLWDRM7ADEWxi23HyNSij5cHBL94r7v --out ./promo
//
// How: headless Chrome loads the page in ?record=1&clock=manual (window.__btw, DESIGN.md / W1): the page has
// no audio and no timers, its grid comes from a fake clock this script steps. Per frame: __btw.setTime(t),
// __btw.frame() (one service()+marks()+DOM pass), Page.captureScreenshot -> ffmpeg image2pipe. The audio is the
// Rust render of the same program (btwd render, offline: same engine as `djctl btw render`), trimmed to the
// same window, so picture and sound share one clock by construction: perfectly synced and stutter-free.
//
// Outputs (in --out): btw-demo.mp4 (H.264 CRF 20 veryfast, AAC 192k, 1920x1080, faststart),
// btw-hero-loop.mp4 + btw-hero-loop.webm (silent, the drop with markers), btw-poster.png.
// What the render does not have: control lines (filter sweeps, reverb) - the offline renderer has no op
// for registry calls yet (docs/BTW.md "Evaluating"), so the audio is the notes and sounds without the risers.
//
// No npm: Node >= 22 (global fetch and WebSocket), ffmpeg on PATH, Google Chrome.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => {
  if (x.startsWith('--')) a.push([x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true])
  return a
}, []))
const W = 1920, H = 1080
const fps = +(args.fps || 30)
const server = (args.server || 'http://127.0.0.1:18097').replace(/\/$/, '')
const btwd = resolve((args.btwd || 'target/release/btwd').replace(/^~/, homedir()))
const outDir = resolve(String(args.out || './promo').replace(/^~/, homedir()))
const which = String(args.only || 'demo,hero,poster').split(',')
const chrome = args.chrome || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const source = args.cid ? `cid=${encodeURIComponent(args.cid)}` : `example=${encodeURIComponent(args.example || 'hand-dubstep-140-v4')}`
const prefix = args.prefix || 'btw'
mkdirSync(outDir, { recursive: true })

const log = (...a) => console.error('[record]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- Chrome + a minimal CDP client ----
const port = 9300 + Math.floor(Math.random() * 500)
const profile = mkdtempSync(join(tmpdir(), 'btw-rec-'))
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, '--force-device-scale-factor=1', '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu-vsync', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' })
process.on('exit', () => { try { proc.kill() } catch {} })

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      const t = await r.json()
      const ws = new WebSocket(t.webSocketDebuggerUrl)
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
      return ws
    } catch { await sleep(100) }
  }
  throw new Error('Chrome did not come up')
}
const ws = await connect()
let nextId = 1
const pending = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result) } }
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })) })
const evalJs = async (expression, awaitPromise = false) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}

await cdp('Page.enable'); await cdp('Runtime.enable')
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
const url = `${server}/?record=1&clock=manual&${source}`
log('open', url)
await cdp('Page.navigate', { url })
await evalJs('(async()=>{ for (let i=0;i<300 && !window.__btw;i++) await new Promise(r=>setTimeout(r,100)); if(!window.__btw) throw new Error("no window.__btw: is the page in record mode?"); await window.__btw.ready; return true })()', true)
const info = await evalJs('JSON.stringify(window.__btw.info())').then(JSON.parse)
log('program', info.name, info.cid, `${info.bpm} bpm`, `${info.bars} bars`, `${(info.seconds || 0).toFixed(1)} s`, info.sections?.map((s) => `${s.name}@${s.start}+${s.bars}`).join(' '))
const bpm = info.bpm, barSec = 240 / bpm

// Step the fake clock to t with no screenshot (so the runtime sees a smooth clock, never a jump).
let clock = 0
async function advanceTo(t, shot) {
  const step = 1 / fps
  while (clock < t - 1e-9) {
    clock = Math.min(t, clock + step)
    await evalJs(`window.__btw.setTime(${clock}); window.__btw.frame(); 0`)
  }
}
async function frameAt(t) {
  await advanceTo(t)
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  return Buffer.from(r.data, 'base64')
}

// ---- audio: the Rust render of the same program ----
async function programText() {
  if (info.canonical || info.text) return info.canonical || info.text
  for (const u of [`${server}/api/programs/${info.cid}`, args.example ? `${server}/examples/${args.example}.btw` : null]) {
    if (!u) continue
    const r = await fetch(u); if (!r.ok) continue
    const ct = r.headers.get('content-type') || ''
    return ct.includes('json') ? (await r.json()).text : await r.text()
  }
  throw new Error('cannot get the program text for ' + info.cid)
}
async function renderAudio(wavPath) {
  if (existsSync(wavPath)) return
  log('render audio with', btwd)
  const text = await programText()
  const f = join(profile, 'program.btw'); writeFileSync(f, text)
  // 48 kHz s16le straight into ffmpeg -> wav
  const r = spawnSync('bash', ['-c', `"${btwd}" render --file "${f}" --sr 48000 --format s16le 2>"${wavPath}.log" | ffmpeg -y -loglevel error -f s16le -ar 48000 -ac 2 -i - "${wavPath}"`], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error('audio render failed, see ' + wavPath + '.log')
}

// ---- windows: where in the song the demo and the loop sit ----
function section(name) { return info.sections?.find((s) => s.name === name) }
const drop = section('drop') || section('drop2') || info.sections?.[Math.floor((info.sections?.length || 1) / 2)] || { start: 0, bars: 8 }
const build = section('build')
// demo: ~52 s ending on a bar line, starting a couple of bars before the build so the intro->build->drop arc is in it
let demoStartBar = args['start-bar'] != null ? +args['start-bar'] : Math.max(0, (build ? build.start : drop.start - 8) - 4)
let demoBars = Math.round(+(args.seconds || 52) / barSec)
demoBars = Math.max(8, Math.min(demoBars, Math.max(8, info.bars - demoStartBar)))
const heroBars = Math.max(4, Math.round(+(args['hero-seconds'] || 12) / barSec))
const heroStartBar = Math.max(0, drop.start + 1)

async function encode({ out, startBar, bars, audio, extra }) {
  const t0 = startBar * barSec, dur = bars * barSec, frames = Math.round(dur * fps)
  log(`encode ${out}: bars ${startBar}..${startBar + bars} (${dur.toFixed(1)} s, ${frames} frames)`)
  clock = 0
  await advanceTo(t0) // pre-roll: the runtime sees every step, no screenshots
  const inputs = ['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-']
  if (audio) inputs.push('-ss', String(t0), '-t', String(dur), '-i', audio)
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, ...extra, out], { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise((res, rej) => { ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))) })
  for (let i = 0; i < frames; i++) {
    const png = await frameAt(t0 + i / fps)
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r))
    if (i % 150 === 0) log(`  frame ${i}/${frames}`)
  }
  ff.stdin.end(); await done
  log('wrote', out, `${(statSync(out).size / 1e6).toFixed(1)} MB`)
}

const results = {}
if (which.includes('demo')) {
  const wav = join(outDir, `${prefix}-demo.audio.wav`)
  await renderAudio(wav)
  const out = join(outDir, `${prefix}-demo.mp4`)
  await encode({ out, startBar: demoStartBar, bars: demoBars, audio: wav,
    extra: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart'] })
  results.demo = out
}
if (which.includes('hero')) {
  const mp4 = join(outDir, `${prefix}-hero-loop.mp4`), webm = join(outDir, `${prefix}-hero-loop.webm`)
  await encode({ out: mp4, startBar: heroStartBar, bars: heroBars, audio: null,
    extra: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-an', '-movflags', '+faststart'] })
  await encode({ out: webm, startBar: heroStartBar, bars: heroBars, audio: null,
    extra: ['-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0', '-pix_fmt', 'yuv420p', '-r', String(fps), '-an'] })
  results.hero = [mp4, webm]
}
if (which.includes('poster')) {
  const t = (drop.start + 1) * barSec + 0.37 * barSec // a moment with lamps lit in the drop
  clock = 0
  const png = await frameAt(t)
  const out = join(outDir, `${prefix}-poster.png`)
  writeFileSync(out, png); log('wrote', out)
  results.poster = out
}
writeFileSync(join(outDir, `${prefix}-manifest.json`), JSON.stringify({ program: info.cid, name: info.name, bpm, source: url, fps, size: [W, H], demo: { startBar: demoStartBar, bars: demoBars }, hero: { startBar: heroStartBar, bars: heroBars }, results }, null, 1))
log('done', JSON.stringify(results))
try { ws.close() } catch {}
proc.kill()
process.exit(0)

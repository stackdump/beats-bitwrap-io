// The driver owns the BtwRun and one source of time. Two kinds of source share one interface:
//   grid()    what BtwRun.service() wants ({deck, beat, bpm, playing:{A,B}} or null)
//   handle()  what to do with the commands service()/stop() return
// - EngineSource: the in-browser engine; its commands are applied (edits land on the next bar).
// - VirtualSource: a clock the page already has (the streamed render, or record mode's fake clock); the
//   commands are discarded and `play` commands are echoed into its playing flags (virtual mode).
// tick(now) is one pass: service, then marks and status. It is the only thing the frame loop calls.

export class EngineSource {
  constructor(engine) {
    this.kind = 'engine';
    this.engine = engine;
  }
  grid() {
    return this.engine.grid();
  }
  handle(cmds) {
    if (cmds && cmds.length) this.engine.apply(cmds);
  }
  stop() {}
}

export class VirtualSource {
  /** clock: anything with grid() and echo(cmds); `kind` is what the page shows ('stream' | 'manual'). */
  constructor(clock, kind = 'stream') {
    this.kind = kind;
    this.clock = clock;
  }
  grid() {
    return this.clock.grid();
  }
  handle(cmds) {
    this.clock.echo(cmds);
  }
  stop() {
    if (this.clock.stop) this.clock.stop();
  }
}

/** A clock the page sets by hand (record mode, ?clock=manual): beat = seconds x bpm / 60. */
export class ManualClock {
  constructor(bpm = 120) {
    this.t = 0;
    this.bpm = bpm;
    this.playing = { A: false, B: false };
  }
  setTime(t) {
    this.t = t;
  }
  /** null until a deck plays: the runtime anchors bar 0 on the first grid it sees, so it must not see one before its `play`. */
  grid() {
    if (!this.playing.A && !this.playing.B) return null;
    return { deck: 'A', beat: (this.t * this.bpm) / 60, bpm: this.bpm, playing: { ...this.playing } };
  }
  echo(cmds) {
    for (const c of cmds || []) if (c && c.op === 'play') this.playing[c.deck] = !!c.on;
  }
}

export class Driver {
  constructor(btw) {
    this.btw = btw;
    this.run = null;
    this.src = null;
    this.evalText = null; // the text the running program was evaluated from (markers are in its coordinates)
    this.evalCid = null;
    this.last = null; // the last tick's {marks, status, grid}
  }

  get kind() {
    return this.src ? this.src.kind : null;
  }

  /**
   * Evaluate `text` on `src`. On the same kind of source as the running program the same BtwRun takes it
   * (a hot reload: it lands on the next bar); otherwise a fresh BtwRun starts. Returns the eval answer;
   * `ok: false` means nothing changed and the last good program plays on.
   */
  evaluate(text, src) {
    const same = this.run && this.src && src === this.src;
    const run = same ? this.run : this.btw.newRun();
    const res = run.eval(text);
    if (!res.ok) {
      if (!same) run.free();
      return res;
    }
    if (!same) {
      if (this.run) this.stopSound();
      this.run = run;
      this.src = src;
    }
    this.evalText = text;
    this.evalCid = res.cid || run.cid();
    return res;
  }

  /** One pass: service the runtime with the source's clock, hand its commands on, read what to show. */
  tick() {
    if (!this.run || !this.src) return null;
    const grid = this.src.grid();
    const cmds = this.run.service(grid);
    this.src.handle(cmds);
    this.last = { marks: this.run.marks(), status: this.run.status(), grid, evalText: this.evalText };
    return this.last;
  }

  /** Stop the program: the runtime puts back what its lines held, then the decks stop and the clock goes. */
  stopSound() {
    if (!this.run || !this.src) return;
    try {
      this.src.handle(this.run.stop());
      this.src.handle([{ op: 'play', deck: 'A', on: false }, { op: 'play', deck: 'B', on: false }]);
    } catch { /* a stopped runtime has nothing to put back */ }
    this.src.stop();
    this.run.free();
    this.run = null;
    this.src = null;
    this.evalText = null;
    this.evalCid = null;
    this.last = null;
  }
}

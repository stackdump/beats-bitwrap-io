// Paints a marker model (markers-model.js) onto the editor's layers. Everything is an inline style
// written from the model each frame: no CSS transitions or animations, no timers, so the same model is
// the same pixels (record mode renders the demo video frame by frame from this). Elements are pooled by
// key and only touched when their style string changes.

import { h } from './util.js';
import { lampStyle, rgba } from './markers-model.js';

export class MarkerPainter {
  constructor(editor) {
    this.ed = editor;
    this.pools = { under: new Map(), over: new Map(), bars: new Map() };
    this.gen = null;
    this.last = null;
  }

  clear() {
    this.paint(null);
  }

  paint(model) {
    const ed = this.ed;
    const m = ed.metrics;
    if (!model) {
      ed.setGutter(null, -1);
      for (const pool of Object.values(this.pools)) {
        for (const e of pool.values()) e.remove();
        pool.clear();
      }
      if (this.gen) this.gen.hidden = true;
      return;
    }
    ed.setGutter(model.gutter, model.header ? model.header.line : -1);
    const seenUnder = new Set();
    const seenOver = new Set();
    for (const l of model.lamps) {
      const over = l.layer === 'over';
      const pool = over ? this.pools.over : this.pools.under;
      (over ? seenOver : seenUnder).add(l.key);
      let el = pool.get(l.key);
      if (!el) {
        el = h('div', { class: `lamp lamp-${l.kind}` });
        (over ? ed.over : ed.under).append(el);
        pool.set(l.key, el);
        if (over) el.textContent = l.text;
      }
      const pad = over ? 0 : 3;
      const css = `left:${m.padLeft + l.c0 * m.charW - pad}px;top:${m.padTop + l.line * m.lineH}px;width:${(l.c1 - l.c0) * m.charW + pad * 2}px;height:${m.lineH}px;`;
      let style;
      if (over) {
        const s = lampStyle(l.k);
        style = `${css}background:${s.background};color:${s.color};`;
      } else style = `${css}background:${rgba(l.color, l.k)};`;
      if (el._style !== style) {
        el.style.cssText = style;
        el._style = style;
      }
    }
    sweep(this.pools.under, seenUnder);
    sweep(this.pools.over, seenOver);

    const seenBars = new Set();
    for (const b of model.bars) {
      seenBars.add(b.key);
      let el = this.pools.bars.get(b.key);
      if (!el) {
        el = h('div', { class: `bar bar-${b.kind}` }, h('i', {}));
        ed.bars.append(el);
        this.pools.bars.set(b.key, el);
      }
      const top = m.padTop + (b.line + 1) * m.lineH - (b.kind === 'section' ? 2 : 3);
      const width = b.kind === 'section' ? '100%' : `${b.cols * m.charW}px`;
      const css = `top:${top}px;width:${width};`;
      if (el._style !== css) {
        el.style.cssText = css;
        el._style = css;
      }
      const fill = `width:${(b.frac * 100).toFixed(2)}%;`;
      if (el._fill !== fill) {
        el.firstChild.style.cssText = fill;
        el._fill = fill;
      }
    }
    sweep(this.pools.bars, seenBars);

    if (model.gen) {
      if (!this.gen) {
        this.gen = h('div', { class: 'gen' });
        ed.bars.append(this.gen);
      }
      const g = model.gen;
      const style = `top:${m.padTop + g.line * m.lineH}px;height:${m.lineH}px;line-height:${m.lineH}px;opacity:${(g.flash ? 0.25 + 0.75 * g.k : 0.55).toFixed(3)};`;
      if (this.gen._style !== style) {
        this.gen.style.cssText = style;
        this.gen._style = style;
      }
      const label = `gen ${g.n}`;
      if (this.gen.textContent !== label) this.gen.textContent = label;
      this.gen.hidden = false;
    } else if (this.gen) this.gen.hidden = true;
  }
}

function sweep(pool, seen) {
  for (const [k, e] of pool) {
    if (!seen.has(k)) {
      e.remove();
      pool.delete(k);
    }
  }
}

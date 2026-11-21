// Paints a marker model (markers-model.js) onto the editor's layers. Everything is an inline style
// written from the model each frame: no CSS transitions or animations, no timers, so the same model is
// the same pixels (record mode renders the demo video frame by frame from this). Elements are pooled by
// key and only touched when their style string changes.

import { h } from './util.js';
import { lampStyle, rgba } from './markers-model.js';
import { pieces, lineTop, lineBottom } from './wrap-model.js';

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
    const L = ed.wrap;
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
      // a lamp on a wrapped line is one element per row it crosses (the first keeps the lamp's own key)
      const ps = pieces(L, l.line, l.c0, l.c1);
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const key = i ? `${l.key}#${i}` : l.key;
        (over ? seenOver : seenUnder).add(key);
        let el = pool.get(key);
        const text = over ? l.text.slice(p.c0 - l.c0, p.c1 - l.c0) : '';
        if (!el) {
          el = h('div', { class: `lamp lamp-${l.kind}` });
          (over ? ed.over : ed.under).append(el);
          pool.set(key, el);
        }
        if (over && el.textContent !== text) el.textContent = text;
        const pad = over ? 0 : 3;
        const css = `left:${p.x - pad}px;top:${p.y}px;width:${p.w + pad * 2}px;height:${m.lineH}px;`;
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
      const top = lineBottom(L, b.line) - (b.kind === 'section' ? 2 : 3);
      const width = b.kind === 'section' ? '100%' : `min(${b.cols * m.charW}px, calc(100% - ${m.padLeft * 2}px))`;
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
      const style = `top:${lineTop(L, g.line)}px;height:${m.lineH}px;line-height:${m.lineH}px;opacity:${(g.flash ? 0.25 + 0.75 * g.k : 0.55).toFixed(3)};`;
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

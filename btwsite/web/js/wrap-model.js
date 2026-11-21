// Where a (line, visual column) is on screen once the editor soft-wraps. The browser wraps the text (the
// textarea and the highlighted <pre> share one width, font and `text-indent: <hang> hanging each-line`, so
// they wrap alike); the editor reads off where each long line's rows start (wrapStarts) and everything
// that paints in character cells (squiggles, lamps, bars, the gutter, the hover) asks this model.
// Pure functions of numbers: the tests drive them without a browser.
//
// layout = { lineH, padTop, padLeft, charW, hang, lines: [{ top, rows: [0, c1, c2, ...] }] }
//   rows[r] is the visual column the r-th row of the line starts at; rows after the first are indented
//   `hang` columns (the hanging indent).

/** A layout for lines whose row starts are known (`starts[l]` = [0, ...]; a missing entry is one row). */
export function buildLayout(starts, { lineH, padTop, padLeft, charW, hang }) {
  const lines = [];
  let top = padTop;
  for (let l = 0; l < starts.length; l++) {
    const rows = starts[l] && starts[l].length ? starts[l] : [0];
    lines.push({ top, rows });
    top += rows.length * lineH;
  }
  return { lineH, padTop, padLeft, charW, hang, lines, height: top - padTop };
}

/** The row of `line` that holds visual column `vcol`. */
export function rowOf(L, line, vcol) {
  const rows = (L.lines[line] || { rows: [0] }).rows;
  let r = 0;
  while (r + 1 < rows.length && rows[r + 1] <= vcol) r++;
  return r;
}

/** Number of rows `line` takes. */
export function rowsOf(L, line) {
  return (L.lines[line] || { rows: [0] }).rows.length;
}

/** Top of `line` (its first row), in the code layer's coordinates. */
export function lineTop(L, line) {
  const ln = L.lines[Math.min(Math.max(line, 0), L.lines.length - 1)];
  return ln ? ln.top : L.padTop;
}

/** Bottom of `line` (its last row). */
export function lineBottom(L, line) {
  return lineTop(L, line) + rowsOf(L, line) * L.lineH;
}

/** {x, y, row} of the cell at (line, vcol). */
export function cellXY(L, line, vcol) {
  const rows = (L.lines[line] || { rows: [0] }).rows;
  const r = rowOf(L, line, vcol);
  const indent = r > 0 ? L.hang : 0;
  return { x: L.padLeft + (indent + vcol - rows[r]) * L.charW, y: lineTop(L, line) + r * L.lineH, row: r };
}

/** The pieces of [c0, c1) on `line`, one per row it crosses: [{row, c0, c1, x, y, w}]. */
export function pieces(L, line, c0, c1) {
  const rows = (L.lines[line] || { rows: [0] }).rows;
  const out = [];
  if (c1 <= c0) return out;
  for (let r = rowOf(L, line, c0); r < rows.length; r++) {
    const a = Math.max(c0, rows[r]);
    const b = r + 1 < rows.length ? Math.min(c1, rows[r + 1]) : c1;
    if (b > a) {
      const p = cellXY(L, line, a);
      out.push({ row: r, c0: a, c1: b, x: p.x, y: p.y, w: (b - a) * L.charW });
    }
    if (r + 1 >= rows.length || rows[r + 1] >= c1) break;
  }
  return out;
}

/** The (line, vcol) under a point in the code layer's coordinates, or null above the first line. */
export function hit(L, x, y) {
  if (!L.lines.length || y < L.padTop) return null;
  let lo = 0;
  let hi = L.lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (L.lines[mid].top <= y) lo = mid;
    else hi = mid - 1;
  }
  const ln = L.lines[lo];
  const r = Math.min(Math.floor((y - ln.top) / L.lineH), ln.rows.length - 1);
  if (lo === L.lines.length - 1 && y >= ln.top + ln.rows.length * L.lineH) return null;
  const indent = r > 0 ? L.hang : 0;
  const vcol = ln.rows[r] + Math.floor((x - L.padLeft) / L.charW) - indent;
  return { line: lo, vcol: Math.max(vcol, ln.rows[r]) };
}

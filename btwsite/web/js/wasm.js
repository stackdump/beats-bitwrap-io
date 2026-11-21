// The module facade. Loads the real wasm (wasm/btw.js + btw_bg.wasm, built from the Rust crates and
// committed to the deploy by hand, never to git) or, with ?mock=1, the stand-in in wasm-mock.js, and
// answers parsed JSON. If the module cannot be loaded the page degrades: `loadBtw` rejects and the page
// says so and keeps a plain editor.

const j = (s) => (typeof s === 'string' ? JSON.parse(s) : s);

export async function loadBtw({ mock = false } = {}) {
  let mod;
  let wasmUrl = null;
  if (mock) {
    mod = (await import('./wasm-mock.js')).mockModule();
  } else {
    const glue = new URL('../wasm/btw.js', import.meta.url);
    wasmUrl = new URL('../wasm/btw_bg.wasm', import.meta.url).href;
    mod = await import(glue.href);
    await mod.default({ module_or_path: wasmUrl });
  }
  return makeFacade(mod, wasmUrl);
}

export function makeFacade(mod, wasmUrl = null) {
  let lastText = null;
  let lastSpans = [];
  return {
    mock: !!mod.mock,
    wasmUrl,
    check: (text) => j(mod.btw_check(text)),
    fmt: (text) => j(mod.btw_fmt(text)),
    open: (s) => j(mod.btw_open(s)),
    share: (text, sig = null, notes = null) => j(mod.btw_share(text, sig, notes)),
    instruments: () => j(mod.btw_instruments()),
    generation: (text, scope, n) => j(mod.btw_generation(text, scope || null, n)),
    cheatsheet: () => mod.btw_cheatsheet(),
    /** The seeded generator ({genre,bpm,key,length,seed} -> {ok,text,cid,check,...}); null when the module predates it. */
    generate: mod.btw_generate ? (req) => j(mod.btw_generate(JSON.stringify(req || {}))) : null,
    /** [[start16, end16, class], ...] */
    highlight(text) {
      if (text === lastText) return lastSpans;
      lastSpans = j(mod.btw_highlight(text));
      lastText = text;
      return lastSpans;
    },
    newRun() {
      return wrapRun(new mod.BtwRun());
    },
  };
}

function wrapRun(raw) {
  return {
    raw,
    eval: (text) => j(raw.eval(text)),
    stop: () => j(raw.stop()) || [],
    /** grid: {deck, beat, bpm, playing:{A,B}} or null */
    service: (grid) => j(raw.service(JSON.stringify(grid || null))) || [],
    marks: () => j(raw.marks()),
    status: () => j(raw.status()),
    cid: () => raw.running_cid() || null,
    free() {
      if (raw.free) raw.free();
    },
  };
}

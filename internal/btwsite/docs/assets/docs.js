// The docs pages' only script. Everything it adds is progressive: the page reads without it.
//   - highlights every BeatScript code block with the editor's own highlighter (btw_highlight in the wasm,
//     through /js/wasm.js and /js/highlight.js), after a first paint with the plain fallback (comments only)
//   - shows the Copy buttons
//   - "Try it": seals the block into a share link (btw_share) and opens the editor at /#<CID>.<packed>:
//     the program travels in the fragment, which is never sent to a server, never in a query string
//   - marks the section being read in the table of contents
// ?mock=1 uses the page's JS stand-in for the wasm, as the editor does.

// like the editor, ?mock=1 counts only on this machine
const MOCK = new URLSearchParams(location.search).get('mock') === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const sourceOf = (code) => code.textContent.replace(/\n$/, '');

let btwP = null;
const loadWasm = () => btwP || (btwP = import('/js/wasm.js').then((m) => m.loadBtw({ mock: MOCK })));
const highlightMod = () => import('/js/highlight.js');

async function highlightAll() {
  const blocks = $$('figure.code[data-btw] code');
  if (!blocks.length) return;
  const { spansToHtml, plainSpans } = await highlightMod();
  for (const code of blocks) {
    const text = sourceOf(code);
    code.innerHTML = spansToHtml(text, plainSpans(text));
  }
  try {
    const btw = await loadWasm();
    for (const code of blocks) {
      const text = sourceOf(code);
      code.innerHTML = spansToHtml(text, btw.highlight(text));
    }
    document.documentElement.dataset.highlight = btw.mock ? 'mock' : 'wasm';
  } catch {
    document.documentElement.dataset.highlight = 'plain'; // the wasm is not there: the plain fallback stays
  }
}

function flash(btn, label, ms = 1600) {
  const old = btn.dataset.label || (btn.dataset.label = btn.textContent);
  btn.textContent = label;
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = old; }, ms);
}

function wireButtons() {
  for (const fig of $$('figure.code')) {
    const code = fig.querySelector('code');
    const cp = fig.querySelector('button.cp');
    if (cp) {
      cp.hidden = false;
      cp.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(sourceOf(code));
          flash(cp, 'Copied');
        } catch {
          const r = document.createRange();
          r.selectNodeContents(code);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          flash(cp, 'Press Ctrl+C');
        }
      });
    }
    const tr = fig.querySelector('button.try');
    if (tr) {
      tr.hidden = false;
      tr.addEventListener('click', async () => {
        tr.disabled = true;
        try {
          const btw = await loadWasm();
          const r = btw.share(sourceOf(code), null, null);
          const frag = r && r.ok && typeof r.url === 'string' ? r.url.split('#')[1] : '';
          if (!frag) { flash(tr, 'Not a whole program'); return; }
          const url = `/#${frag}`;
          window.__lastTry = url; // for the smoke check
          window.open(url, '_blank', 'noopener');
        } catch {
          flash(tr, 'Editor engine unavailable');
        } finally {
          tr.disabled = false;
        }
      });
    }
  }
}

function watchToc() {
  const links = new Map($$('.toc a[href^="#"]').map((a) => [a.getAttribute('href').slice(1), a]));
  if (!links.size || !('IntersectionObserver' in window)) return;
  const heads = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links.values()) a.classList.remove('on');
      links.get(e.target.id)?.classList.add('on');
    }
  }, { rootMargin: '-60px 0px -70% 0px' });
  heads.forEach((h) => io.observe(h));
}

wireButtons();
watchToc();
highlightAll();

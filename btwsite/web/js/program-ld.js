// A program embedded in the page: <beatscript-view data-editor data-ui="bar"> whose child
// <script type="application/ld+json"> is the program's source (https://beatscript.app/schema), as pflow.xyz's
// <petri-view> reads its net. The server renders it into /?cid=<CID> and the program pages; the editor loads it from
// here instead of fetching. Its text must hash to its @id: the app checks that before it plays (app.js loadEmbedded).

/** The block's document, parsed and its shape checked: {cid, text, name, license, signature, doc}. Throws when it is not a program. */
export function parseProgramLd(json) {
  let d;
  try {
    d = JSON.parse(json);
  } catch {
    throw new Error('the page\'s program block is not JSON');
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('the page\'s program block is not an object');
  const types = Array.isArray(d['@type']) ? d['@type'] : [d['@type']];
  if (!types.includes('Program')) throw new Error('the page\'s program block is not a Program');
  if (typeof d['@id'] !== 'string' || !/^z[1-9A-HJ-NP-Za-km-z]{20,80}$/.test(d['@id'])) throw new Error('the page\'s program block has no CID as its @id');
  if (typeof d.text !== 'string' || !d.text) throw new Error('the page\'s program block has no text');
  return {
    cid: d['@id'],
    text: d.text,
    name: typeof d.name === 'string' ? d.name : '',
    license: typeof d.license === 'string' ? d.license : 'CC0-1.0',
    signature: typeof d.signature === 'string' ? d.signature : null,
    doc: d,
  };
}

/** The editor's program in `root` (a document or an element): the first <beatscript-view data-editor>'s child script. Null: there is none. */
export function readProgramView(root) {
  const el = root && root.querySelector ? root.querySelector('beatscript-view[data-editor]') : null;
  if (!el) return null;
  const s = el.querySelector('script[type="application/ld+json"]');
  if (!s) return null;
  return parseProgramLd(s.textContent);
}

/** <beatscript-view> as a known element. The editor reads its script; the element itself draws nothing (the page is the editor). */
export function defineProgramView(reg = globalThis.customElements) {
  if (!reg || reg.get('beatscript-view') || typeof HTMLElement === 'undefined') return;
  reg.define('beatscript-view', class extends HTMLElement {
    /** The program this element carries (null when its block is missing or malformed). */
    get program() {
      const s = this.querySelector('script[type="application/ld+json"]');
      try { return s ? parseProgramLd(s.textContent) : null; } catch { return null; }
    }
  });
}

// The CID-only btw link (/p/<CID>): the page fetches the text from the program store and checks it against the CID.
// A store that answers another program's text is refused; an unknown CID is an error with words; the self-sealing
// form (#CID.packed) is untouched. Run: node scripts/test-btw-link.mjs   (make test-btw-link)
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { computeCidForJsonLd } from '../public/lib/share/codec.js';
import { cidFromPath, openStored, openLocation, openLink } from '../public/lib/btw/link.js';

const cidOf = (text) => computeCidForJsonLd({ format: 1, text, type: 'djrust.live' });
const textA = 'tempo 120\nkey am\ndeck A: kick x ~ x ~\nsection intro 2 bars\n';
const textB = 'tempo 100\nkey am\ndeck A: kick x ~ x ~\nsection intro 2 bars\n';
const cidA = await cidOf(textA);
const cidB = await cidOf(textB);
const packed = (t) => deflateRawSync(Buffer.from(t)).toString('base64url');

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const store = (map) => async (url) => {
  const cid = url.split('/api/programs/')[1];
  assert.ok(url.startsWith('https://beatscript.app/api/programs/'), url);
  return map[cid] ? json(200, map[cid]) : json(404, { error: { code: 'not_found' } });
};

// paths
assert.equal(cidFromPath('/p/' + cidA), cidA);
assert.equal(cidFromPath('/p/' + cidA + '/'), cidA);
assert.equal(cidFromPath('/p'), null);
assert.equal(cidFromPath('/p/nope'), null);
assert.equal(cidFromPath('/x/p/' + cidA), null);

// stored and honest: verified, with its rights
let r = await openStored(cidA, { fetchFn: store({ [cidA]: { cid: cidA, text: textA, meta: { license: 'CC0-1.0', credits: ['Matt'] } } }) });
assert.equal(r.verified, true);
assert.equal(r.computed, cidA);
assert.equal(r.link.text, textA);
assert.deepEqual(r.meta.credits, ['Matt']);

// a store that answers another program under this CID: refused (verified false, the computed CID is the other one)
r = await openStored(cidA, { fetchFn: store({ [cidA]: { cid: cidA, text: textB, meta: {} } }) });
assert.equal(r.verified, false);
assert.equal(r.computed, cidB);

// unknown: words, not a crash; unreachable and odd answers too
await assert.rejects(openStored(cidA, { fetchFn: store({}) }), /no program .* is stored/);
await assert.rejects(openStored(cidA, { fetchFn: async () => { throw new Error('offline'); } }), /could not be reached/);
await assert.rejects(openStored(cidA, { fetchFn: async () => json(500, {}) }), /answered 500/);
await assert.rejects(openStored(cidA, { fetchFn: async () => json(200, { cid: cidA }) }), /no text/);
await assert.rejects(openStored('not-a-cid'), /not a CID/);

// openLocation: a /p/<CID> path, a bare #CID, and the self-sealing form (never touches the store)
const noStore = async () => { throw new Error('the store must not be asked for a self-sealing link'); };
const fetchFn = store({ [cidA]: { cid: cidA, text: textA, meta: {} } });
assert.equal((await openLocation({ pathname: '/p/' + cidA, hash: '' }, { fetchFn })).verified, true);
assert.equal((await openLocation({ pathname: '/p', hash: '#' + cidA }, { fetchFn })).verified, true);
r = await openLocation({ pathname: '/p', hash: '#' + cidA + '.' + packed(textA) }, { fetchFn: noStore });
assert.equal(r.verified, true);
r = await openLocation({ pathname: '/p', hash: '#' + cidB + '.' + packed(textA) }, { fetchFn: noStore });
assert.equal(r.verified, false); // the sealed form's own refusal, as before
assert.equal((await openLink('#' + cidA + '.' + packed(textA))).verified, true);

console.log('btw link: ok');

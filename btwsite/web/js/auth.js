// Sign-in: a challenge-response on the identity beats.bitwrap.io already uses (DESIGN.md "Auth"). The page
// signs the server's challenge message (UTF-8 bytes) with either an eth wallet (window.ethereum
// personal_sign, EIP-191) or a browser-local Ed25519 key (WebCrypto), then POSTs the signature to
// /api/auth/login, which sets the session cookie.
//
// The browser key. Its private half is a **non-extractable** CryptoKey kept in IndexedDB (structured clone keeps the
// object and not its bytes): script on the page can ask it to sign, but cannot read it out, so a page script that goes
// wrong (an XSS) cannot walk away with the account. localStorage `btw-ed25519-v1` holds only `{publicKeyHex}`, to show
// which key it is without an async read. An earlier version kept the private JWK in localStorage: such a key is
// imported as non-extractable, moved to IndexedDB, and its JWK is removed from localStorage once IndexedDB has it.
// Where IndexedDB is not available (a private window) the key lasts this page only.
//
// What is signed. The challenge is checked before anything signs it: it must be plain text that names this site and
// carries its own nonce, so a reply that is not the site's sign-in message is never signed (no blind signing).
// An eth wallet shows the message as text before it signs (personal_sign); the browser key signs the same text.

import { hex } from './util.js';
import { ApiError } from './errors.js';

export const ED_KEY = 'btw-ed25519-v1';
const IDB_NAME = 'btw-keys';
const IDB_STORE = 'keys';
const IDB_ID = 'ed25519';

const ls = () => { try { return globalThis.localStorage; } catch { return null; } };

export const hasWallet = () => !!(globalThis.ethereum && globalThis.ethereum.request);

// ---- where the key is kept ---------------------------------------------------------------------------------------------

/** The IndexedDB key store ({get, put, del}), or null where there is no IndexedDB. */
function idbStore() {
  const idb = globalThis.indexedDB;
  if (!idb) return null;
  let opened = null;
  const open = () => opened || (opened = new Promise((resolve, reject) => {
    let r;
    try { r = idb.open(IDB_NAME, 1); } catch (e) { opened = null; reject(e); return; }
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => { opened = null; reject(r.error || new Error('indexedDB')); };
    r.onblocked = () => { opened = null; reject(new Error('indexedDB blocked')); };
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(IDB_STORE, mode);
      const rq = fn(t.objectStore(IDB_STORE));
      t.oncomplete = () => resolve(rq ? rq.result : undefined);
      t.onerror = () => reject(t.error || new Error('indexedDB'));
      t.onabort = () => reject(t.error || new Error('indexedDB aborted'));
    });
  };
  return { get: () => run('readonly', (s) => s.get(IDB_ID)), put: (v) => run('readwrite', (s) => s.put(v, IDB_ID)), del: () => run('readwrite', (s) => s.delete(IDB_ID)) };
}

let store = null; // made on first use, so a test can give globalThis an indexedDB (or none) first
let storeMade = false;
let held = null; // {publicKeyHex, privateKey} when the key could not be stored: this page only
const keys = () => {
  if (!storeMade) { store = idbStore(); storeMade = true; }
  return store;
};

/** For the tests: use this key store ({get, put, del}, or null for none) and forget what is held. */
export function useKeyStore(s) {
  store = s;
  storeMade = true;
  held = null;
}

const readLocal = () => {
  try { return JSON.parse(ls().getItem(ED_KEY) || 'null'); } catch { return null; }
};
const writeLocal = (v) => { try { ls().setItem(ED_KEY, JSON.stringify(v)); } catch { /* private window */ } };

const isPublicHex = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** The public key of the browser-local key, or null when there is none yet. */
export function localKeyInfo() {
  const c = readLocal();
  return c && isPublicHex(c.publicKeyHex) ? c.publicKeyHex : null;
}

/** Forget the browser key everywhere it is kept: the account that is this key is lost with it. */
export async function resetLocalKey() {
  held = null;
  try { ls().removeItem(ED_KEY); } catch { /* none */ }
  const s = keys();
  if (s) { try { await s.del(); } catch { /* nothing to delete */ } }
}

async function keep(rec) {
  const s = keys();
  if (!s) return false;
  try { await s.put(rec); return true; } catch { return false; }
}

const isRec = (r) => !!(r && isPublicHex(r.publicKeyHex) && r.privateKey && r.privateKey.type === 'private' && r.privateKey.algorithm && r.privateKey.algorithm.name === 'Ed25519');

let loading = null;
/** The browser key, made if there is none. One at a time: two sign-ins at once must not make two keys. */
function loadOrCreateKey() {
  if (held) return Promise.resolve(held);
  if (!loading) loading = makeOrLoadKey().finally(() => { loading = null; });
  return loading;
}

async function makeOrLoadKey() {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new ApiError({ code: 'bad_request', message: 'this page needs a secure context (https) for browser keys' });
  // 1. the key as stored
  try {
    const s = keys();
    const rec = s ? await s.get() : null;
    if (isRec(rec)) return rec;
  } catch { /* unreadable: look for an older copy, else make a new key */ }
  // 2. an older version's key (its JWK in localStorage): imported as non-extractable and moved
  const old = readLocal();
  if (old && old.privateKeyJwk && isPublicHex(old.publicKeyHex)) {
    try {
      const privateKey = await subtle.importKey('jwk', old.privateKeyJwk, { name: 'Ed25519' }, false, ['sign']);
      const rec = { publicKeyHex: old.publicKeyHex, privateKey };
      if (await keep(rec)) writeLocal({ publicKeyHex: old.publicKeyHex }); // the JWK goes only once the store has the key
      else held = rec;
      return rec;
    } catch { /* not a usable key: make a new one */ }
  }
  // 3. a new key, whose private half cannot be exported
  let pair;
  try {
    pair = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  } catch {
    throw new ApiError({ code: 'bad_request', message: 'this browser cannot make an Ed25519 key (Chrome 137+, Safari 17+ or Firefox 129+ can). Use a wallet instead.' });
  }
  const publicKeyHex = hex(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const rec = { publicKeyHex, privateKey: pair.privateKey };
  if (await keep(rec)) writeLocal({ publicKeyHex });
  else held = rec;
  return rec;
}

// ---- the challenge ------------------------------------------------------------------------------------------------------

/**
 * Check a challenge before it is signed: `{nonce, message}` where the message is plain ASCII text of a few lines, the
 * first "<host> sign-in" with a host in `hosts` (this page's and the server's public URL's), and one line "nonce: <its
 * nonce>". Returns the message; throws an ApiError saying why not.
 */
export function checkChallenge(ch, { hosts } = {}) {
  const no = (why) => new ApiError({ code: 'bad_request', message: `the sign-in challenge was not signed: ${why}` });
  if (!ch || typeof ch.message !== 'string' || typeof ch.nonce !== 'string' || !ch.nonce) throw no('it is not in the expected shape');
  const m = ch.message;
  if (m.length > 512) throw no('it is too long');
  if (/[^\n\x20-\x7e]/.test(m)) throw no('it has characters other than plain text');
  const lines = m.split('\n');
  const first = /^(\S+) sign-in$/.exec(lines[0]);
  if (!first) throw no('it does not start with "<site> sign-in"');
  if (hosts && hosts.length && !hosts.includes(first[1])) throw no(`it is for ${first[1]}, not for this site`);
  if (!lines.includes(`nonce: ${ch.nonce}`)) throw no('it does not carry its own nonce');
  return m;
}

// ---- signing --------------------------------------------------------------------------------------------------------------

/** {type, address, signature} for `message`, signed with the browser key. */
export async function signEd25519(message) {
  const { publicKeyHex, privateKey } = await loadOrCreateKey();
  const sig = await globalThis.crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(message));
  return { type: 'ed25519', address: publicKeyHex, signature: hex(new Uint8Array(sig)) };
}

/** {type, address, signature} for `message`, signed by the wallet (personal_sign shows the message as text). */
export async function signEth(message) {
  const eth = globalThis.ethereum;
  if (!eth || !eth.request) throw new ApiError({ code: 'bad_request', message: 'no eth wallet in this browser' });
  const accounts = await eth.request({ method: 'eth_requestAccounts' });
  const address = String((accounts && accounts[0]) || '').toLowerCase();
  if (!address) throw new ApiError({ code: 'bad_request', message: 'no account was selected' });
  const signature = await eth.request({ method: 'personal_sign', params: [message, address] });
  return { type: 'eth', address, signature };
}

/**
 * The whole sign-in. kind: 'eth' | 'ed25519'. `opts.hosts`: the hosts a challenge may name (the page's own, and the
 * server's public URL's); with none given the host is only required to be well formed. Returns the user the server answered.
 */
export async function signIn(api, kind, opts = {}) {
  const ch = await api.challenge();
  const message = checkChallenge(ch, opts);
  const sig = kind === 'eth' ? await signEth(message) : await signEd25519(message);
  const r = await api.login({ ...sig, nonce: ch.nonce });
  return r.user;
}

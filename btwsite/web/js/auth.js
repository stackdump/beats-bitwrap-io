// Sign-in: a challenge-response on the identity beats.bitwrap.io already uses (DESIGN.md "Auth"). The page
// signs the server's challenge message (UTF-8 bytes) with either an eth wallet (window.ethereum
// personal_sign, EIP-191) or a browser-local Ed25519 key (WebCrypto; the JWK lives in localStorage under
// btw-ed25519-v1, the approach of beats' public/lib/share/sign.js), then POSTs the signature to
// /api/auth/login, which sets the session cookie.

import { hex } from './util.js';
import { ApiError } from './errors.js';

export const ED_KEY = 'btw-ed25519-v1';

const ls = () => { try { return globalThis.localStorage; } catch { return null; } };

export const hasWallet = () => !!(globalThis.ethereum && globalThis.ethereum.request);

/** The public key of the browser-local key, or null when there is none yet. */
export function localKeyInfo() {
  try {
    const c = JSON.parse(ls().getItem(ED_KEY) || 'null');
    return c && c.publicKeyHex ? c.publicKeyHex : null;
  } catch {
    return null;
  }
}

export function resetLocalKey() {
  try { ls().removeItem(ED_KEY); } catch { /* none */ }
}

async function loadOrCreateKey() {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new ApiError({ code: 'bad_request', message: 'this page needs a secure context (https) for browser keys' });
  try {
    const cached = JSON.parse(ls().getItem(ED_KEY) || 'null');
    if (cached && cached.publicKeyHex && cached.privateKeyJwk) {
      const privateKey = await subtle.importKey('jwk', cached.privateKeyJwk, { name: 'Ed25519' }, false, ['sign']);
      return { publicKeyHex: cached.publicKeyHex, privateKey };
    }
  } catch { /* make a new one */ }
  let pair;
  try {
    pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  } catch {
    throw new ApiError({ code: 'bad_request', message: 'this browser cannot make an Ed25519 key (Chrome 137+, Safari 17+ or Firefox 129+ can). Use a wallet instead.' });
  }
  const publicKeyHex = hex(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const privateKeyJwk = await subtle.exportKey('jwk', pair.privateKey);
  try { ls().setItem(ED_KEY, JSON.stringify({ publicKeyHex, privateKeyJwk })); } catch { /* private window: the key lasts this page only */ }
  return { publicKeyHex, privateKey: pair.privateKey };
}

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

/** The whole sign-in. kind: 'eth' | 'ed25519'. Returns the user the server answered. */
export async function signIn(api, kind) {
  const ch = await api.challenge();
  const sig = kind === 'eth' ? await signEth(ch.message) : await signEd25519(ch.message);
  const r = await api.login({ ...sig, nonce: ch.nonce });
  return r.user;
}

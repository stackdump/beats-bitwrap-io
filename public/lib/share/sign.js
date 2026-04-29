// Sign a share envelope with either an eth wallet (window.ethereum
// personal_sign) or an automatic browser-local Ed25519 keypair. The
// resulting envelope carries `signer` (type + public address) and
// `signature` fields; the server verifies both before sealing
// (internal/share/sigverify.go).
//
// Two modes:
//
//   - 'eth' — pops the user's wallet (MetaMask etc.), prompts them
//     to personal_sign the canonical-without-sig bytes (hex-encoded
//     so the wallet treats it as raw bytes). Identity = the eth
//     address that recovers from the signature. Portable: signing
//     proves possession of an existing identity that other apps
//     can recognize.
//
//   - 'ed25519' — auto. First call generates a fresh keypair via
//     WebCrypto, persists the JWK to localStorage, and returns the
//     hex-encoded public key as the address. No wallet popup; the
//     identity is browser-local but stable across sessions. Loses
//     the keypair if the user clears site data.
//
// In both cases the signature commits to the canonical-without-sig
// bytes — `signer` IS retained in those bytes so the signature can't
// be re-bound to a different claimed key. See signedBytes() in
// internal/share/sigverify.go for the parity contract.

import { canonicalizeJSON, computeCidForJsonLd } from './codec.js';

const ED25519_KEY_LSKEY = 'pn-ed25519-keypair-v1';

// JS-side replication of internal/share/sigverify.go's signedBytes:
// the pre-signature CID of the envelope (UTF-8 bytes of the
// base58btc string). Computed by stripping `signature`, canonicalizing
// the rest, and running the same CID hash the server uses. `signer`
// stays in the canonical bytes so the signature commits to the key.
//
// Why CID instead of full canonical bytes: signing the CID is
// equivalent (the verifier recomputes CID from canonical), but the
// wallet popup shows ~50 readable characters instead of a multi-kB
// JSON blob.
async function signedBytesFor(envelope) {
    const clone = { ...envelope };
    delete clone.signature;
    const cid = await computeCidForJsonLd(clone);
    return { cid, bytes: new TextEncoder().encode(cid) };
}

// --- Ed25519 (auto, browser-local) ---

async function loadOrCreateEd25519() {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(ED25519_KEY_LSKEY) || 'null'); } catch {}
    if (cached?.publicKeyHex && cached?.privateKeyJwk) {
        const priv = await crypto.subtle.importKey(
            'jwk', cached.privateKeyJwk, { name: 'Ed25519' }, false, ['sign']);
        return { publicKeyHex: cached.publicKeyHex, privateKey: priv };
    }
    const { publicKey, privateKey } = await crypto.subtle.generateKey(
        { name: 'Ed25519' }, true, ['sign', 'verify']);
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
    const publicKeyHex = Array.from(pubRaw)
        .map(b => b.toString(16).padStart(2, '0')).join('');
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', privateKey);
    try {
        localStorage.setItem(ED25519_KEY_LSKEY,
            JSON.stringify({ publicKeyHex, privateKeyJwk }));
    } catch {}
    return { publicKeyHex, privateKey };
}

async function signEd25519(envelope) {
    const { publicKeyHex, privateKey } = await loadOrCreateEd25519();
    const signer = { type: 'ed25519', address: publicKeyHex };
    // Stamp signer first so signedBytesFor sees it (the signature
    // commits to the claimed key, computed via the pre-sig CID).
    const stamped = { ...envelope, signer };
    const { bytes } = await signedBytesFor(stamped);
    const sigBuf = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, bytes);
    const sig = Array.from(new Uint8Array(sigBuf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
    return { ...stamped, signature: sig };
}

// --- Eth (window.ethereum personal_sign) ---

async function signEth(envelope) {
    const eth = window.ethereum;
    if (!eth?.request) {
        throw new Error('No eth wallet available. Use ed25519 mode or install a wallet.');
    }
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    const address = (accounts?.[0] || '').toLowerCase();
    if (!address) throw new Error('No account selected.');
    const signer = { type: 'eth', address };
    const stamped = { ...envelope, signer };
    const { cid } = await signedBytesFor(stamped);
    // personal_sign with the CID string: MetaMask shows the CID
    // (~50 readable chars) in the popup. The server prepends the
    // EIP-191 \x19 prefix + the byte length of the CID string and
    // recovers the address. Pass the string directly — MetaMask
    // treats non-hex args as UTF-8 text.
    const sig = await eth.request({
        method: 'personal_sign',
        params: [cid, address],
    });
    return { ...stamped, signature: sig };
}

// Public API: signEnvelope(envelope, mode) → returns a new envelope
// with signer + signature set. mode === 'eth' (default — portable
// across hosts, identity = your wallet address) or 'ed25519'
// (browser-local, no popup, identity scoped to this browser). The
// caller re-canonicalizes the result and uses its CID (the
// signature changes the bytes, so the CID changes).
export async function signEnvelope(envelope, mode = 'eth') {
    if (mode === 'ed25519') return signEd25519(envelope);
    return signEth(envelope);
}

// Inspect the local Ed25519 identity without creating one. Returns
// null if the keypair doesn't exist. Used by UI to show "your local
// identity" in the studio.
export function localEd25519PublicKey() {
    try {
        const cached = JSON.parse(localStorage.getItem(ED25519_KEY_LSKEY) || 'null');
        return cached?.publicKeyHex || null;
    } catch {
        return null;
    }
}

// Drop the local Ed25519 keypair. Next signEnvelope('ed25519') call
// will mint a fresh one. Cosmetic — does not invalidate signatures
// already produced under the old key.
export function resetEd25519Identity() {
    try { localStorage.removeItem(ED25519_KEY_LSKEY); } catch {}
}

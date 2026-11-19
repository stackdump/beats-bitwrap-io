# Pairing a phone with btw.bitwrap.io (`btw-pair/1`)

djrust on Android (djandroid, `se.vevr.djandroid`) connects to btw.bitwrap.io by scanning a QR
code. Once paired, the site (and an assistant over its MCP) can send btw programs to the phone and
play them there, and the site sees what the phone plays. Server: `internal/btwsite/server/pair.go`.
Phone: djandroid `rust/src/btwpair.rs` (the protocol core, `network` feature only) and
`app/src/network/java/.../btw/BtwPairingImpl.kt` (the transport). The phone's side is in djandroid
`docs/BTW-PAIR.md`.

## The flow

```
page (signed in)              server                                   phone
POST /api/pair  ───────────▶  offer {pair id, token} (2 min, single use)
◀── QR: https://btw.bitwrap.io/pair#<pair id>.<token>
                                                         scan ◀────────
                              POST /api/pair/claim  ◀──────────────────  {proto, pair_id, token, key, name, ts, sig}
                              verify sig (Ed25519, key), token, expiry
                              device {id, owner = the page's user, key}  ──▶ {device_id, user, address, fingerprint}
GET /api/pair/<id> ── paired, the device's fingerprint (both ends show it)
                              GET /api/device/events (SSE)  ◀───────────  Authorization: BtwDevice <device>.<ts>.<sig>
                              hello, eval, load, stop, get, ping, unpaired ──▶
                              POST /api/device/report (≤ 1/s)  ◀────────  what plays (SessionState)
                              POST /api/device/compose  ◀──────────  {prompt, genre?, key?, length?} (signed)
                              compose as the owner ─────────────────▶  {program, cid, check, share_url, render_url}
POST /api/devices/<id>/push ─▶ eval | load | stop ──────────────────────▶
DELETE /api/devices/<id> ────▶ unpaired ────────────────────────────────▶  (or the phone: DELETE /api/device)
```

## What is signed

Both messages are UTF-8 text, signed with the phone's Ed25519 key (64-byte signature, base64url
without padding). `host` is the server's public host (`btw.bitwrap.io`).

```
btw-pair/1 claim                      btw-pair/1 request
host: <host>                          host: <host>
pair: <pair id>                       device: <device id>
token: <hex sha256(token)>            method: <GET|POST|DELETE>
key: <base64url public key>           path: <URL path, no query>
name: <device name>                   ts: <unix ms>
ts: <unix ms>                         body: <hex sha256(body)>   (of the empty string when there is none)
```

`btwsite/testdata/pair/vectors.json` pins both texts and signatures for a fixed key (seed = 32 bytes
of 0x01). `pair_test.go TestPairVectors` makes it, and djandroid's `btwpair.rs` tests reproduce it
byte for byte, so the two sides cannot drift.

## Rules

- **Nothing long-lived is in the QR.** The token is 128 random bits and works once, for two minutes.
  Any claim with a wrong token burns the offer. Only its SHA-256 is kept, in memory. It sits in the
  link's fragment, so a camera app that opens the link never sends it to the server (`GET /pair`
  explains that the code is for djrust's scanner).
- **No secret is stored on the server.** A device record (`<data>/devices.json`, 0600) is its id,
  its owner, its name and its public key. The phone's key never leaves the phone (djandroid keeps the
  seed in `noBackupFilesDir`).
- **Bound to the identity that showed the code.** The owner is the user signed in on the page (an
  eth wallet or a browser Ed25519 key, the site's sign-in). The phone does not need a wallet of its
  own. Both ends show the key's fingerprint (`sha256(key)[:4]` in hex, as `ab12 cd34`).
- **Signed requests.** The `ts` must be within ±2 min of the server's clock, and a signature already
  seen in that window is refused (a replay). A body that differs from the one signed fails.
- **Re-pair and unpair.** One record per key: a phone that pairs again (with the same account or
  another) replaces its old record, and the old stream gets `unpaired`. Unpairing from either side
  deletes the record. A phone whose record is gone gets `410 unpaired` and forgets the pairing.
  At most 8 phones per user (pairing a 9th drops the oldest) and 3 open offers per user (a 4th
  retires the oldest).
- **A phone is a hub session** owned by the user (`SessionInfo.device` names it), so MCP's
  `eval` / `load` / `stop` / `get` with no session reach it as well as the user's open pages.
- **Pairing grants MCP.** The owner's MCP token (the page's "MCP token" button) lists the owner's
  phones with the `devices` tool and drives one alone with `device: <id>` on `eval` / `load` /
  `get` / `stop`. No new credential is made at pairing and nothing about MCP is in the QR: the grant
  is the device record's owner. Another account's token gets `not_found`.
  `/api/devices/<id>/push` runs the same checks as MCP's `eval`: no program with errors, and no
  restricted or asset-using program, is sent.
- Limits: `POST /api/pair` and `POST /api/pair/claim` allow 20 per minute per address. Device
  streams count toward the 40 SSE streams per address, and reports share the hub's token bucket
  (10/s, burst 20).

## Compose from the phone

`POST /api/device/compose` is the web's `POST /api/compose` for a paired phone. It is signed like
every device request (the `btw-pair/1 request` text, so the body's SHA-256 is covered) and runs
compose **as the pairing owner**: the same per-user hourly and daily allowance (shared with the web
and MCP, counted against the owner's account), the per-address day limit, the kill switch and the
daily spend cap. Body `{prompt, genre?, key?, length?, bpm?, base_cid?}`, unknown fields refused.
The answer is the web route's JSON in one body (the web route does not stream): `program` (canonical
text) and `cid` to play on the phone, plus `check`, `attempts`, `share_url` and `render_url`. The
result is stored publicly (CC0) like any compose. No credential beyond the device key is involved.

## Not done (decide)

- The phone does not countersign with its own did:pkh wallet identity. That would need a biometric
  prompt at pairing; the server would accept an optional `wallet` field on the claim.
- An Android App Link for `https://btw.bitwrap.io/pair` (opening the app straight from the camera)
  needs `/.well-known/assetlinks.json` with the release key's fingerprint.

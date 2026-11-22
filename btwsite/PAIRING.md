# Pairing a phone with the btw site (`btw-pair/2`)

The BeatScript Android app (beatscript-app, formerly djandroid; `app.beatscript`) connects to the btw site by scanning a QR
code. Once paired, the site (and an assistant over its MCP) can send btw programs to the phone and
play them there, and the site sees what the phone plays. Server: btwserve `crates/btwserve/src/hub/pair.rs` in djrust-vevr-se (ported from the retired Go `internal/btwsite/server/pair.go`).
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

## Protocol versions and the site id

`btw-pair/2` (current) signs the site's **id**, not its host: `site: <site id>` where v1 has `host: <host>`. The id is
random, made once (`<data>/site.json`) and travels with the data directory, so the same site served from another
domain keeps every pairing. The phone learns the id from the offer answer (`site_id`), the claim answer, or
`GET <origin>/.well-known/btw-site`. A server verifies a request as v2 first, then as v1 under every host it answers
for (`-alt-origins`), so phones paired before v2 keep working while the old name is an alias. A claim names its
version in `proto`; both are accepted. Pins: `testdata/pair/vectors.json` (v1) and `vectors-v2.json`.

### A moved site

A server started with `-moved-to https://NEW` puts `moved_to` in `/.well-known/btw-site`, in the device hello, and
sends a `moved` event (`{moved_to, site_id, from}`) right after `hello` on every phone stream. The phone must fetch
`NEW/.well-known/btw-site`, check that `site_id` is the one it has stored, and only then switch its origin; it keeps its
device id and key and signs v2 as before, so nothing is re-scanned. A phone that was away finds out the same way when
it next connects (the old name redirects with 308 and keeps answering the well-known document). The runbook is
`btwsite/deploy/MIGRATION.md`.

## What is signed

Both messages are UTF-8 text, signed with the phone's Ed25519 key (64-byte signature, base64url
without padding). Shown as v1; v2 is the same with `btw-pair/2` and `site: <site id>` in place of `host: <host>`
(`host` is the server's public host).

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

`btwsite/testdata/pair/qr-golden.json` pins one whole pairing QR payload as the site makes it
(`PairLink`, `https://beatscript.app/pair#<22>.<22>`, with `-` and `_` in the token) and the v1 claim a
phone signs for it. `pair_qr_golden_test.go` makes it and checks that a live offer's link is `PairLink`'s;
beatscript-app copies it to `rust/tests/btw_pair_qr_golden.json`, and its `btwpair.rs` test parses the payload
with the app's own parser and reproduces the claim byte for byte. `TestPairQRScanSingleUseExpiry` scans as the
phone does on a beatscript.app site: the claim is accepted once, the same claim again is `410 pair_used`, and a
code past two minutes is `410 pair_expired`, each telling the person to show a new code.

## A pairing code is not an invite (2026-11-19)

The app has two QR codes of its own kinds, and they are different credentials:

- **A pairing code** (this document): `https://<site>/pair#<id>.<token>`, made by the site's mobile panel. It
  binds the phone's device key to the signed-in account. In the app: Menu › beatscript.app › Scan to connect,
  or the phone's camera (the link opens the app).
- **An invite** (`bitwrap-invite.v1`, the app's wallet, Menu › Identity › Redeem an invite): a signed JSON
  credential one member gives another. The site never makes one.

Scanning the site's code from the invite scanner used to answer "That isn't a BeatScript invite code"; that was
the reported bug. The Play app was also built without the `network` feature, so it had no pairing scanner at all
and a camera-opened `/pair` link did nothing. beatscript-app `fix/pairing-qr` sends every scanned code to the
flow it belongs to (one router, whichever scanner read it), says what a code is when it cannot use it, and makes
the Play build a network build. One credential flow stays: pairing is the only way a phone gets a site
credential; an invite never becomes one.

## The host after the move (2026-11-19)

`host` in both signed texts is the server's public host. The public origin moved from btw.bitwrap.io to
**beatscript.app**: a new pairing code is `https://beatscript.app/pair#…` and signs `host: beatscript.app`. A phone
paired before the move keeps its origin (`https://btw.bitwrap.io`) and signs `host: btw.bitwrap.io`; the server
accepts every host in `-legacy-hosts` (btw.bitwrap.io), and nginx keeps `/api/` on btw.bitwrap.io proxied rather
than redirected (the phone does not follow redirects), so nobody re-pairs. djandroid still treats only btw.bitwrap.io
as the official host, so it asks "Connect?" before pairing with a beatscript.app code until it learns the new name.

## Rules

- **Nothing long-lived is in the QR.** The token is 128 random bits and works once, for two minutes.
  Any claim with a wrong token burns the offer. Only its SHA-256 is kept, in memory. It sits in the
  link's fragment, so a camera app that opens the link never sends it to the server (`GET /pair`
  explains that the code is for the BeatScript app's scanner).
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
daily spend cap. Body `{prompt, genre?, key?, length?, bpm?, base_cid?, current?}` (`current`: the program in the phone's editor, sent with every prompt after the first; vetted like a `base_cid` program and given to the model to modify), unknown fields refused with a 400 that names the field.
The answer is the web route's JSON in one body (the web route does not stream): `program` (canonical
text) and `cid` to play on the phone, plus `check`, `attempts`, `share_url` and `render_url`. The
result is stored publicly (CC0) like any compose. No credential beyond the device key is involved.

### Capabilities (2026-11-20)

The claim answer and `GET /api/device/me` also carry `caps` (e.g. `["compose"]`) and `grant`, a signed
`btw-cap+jws` statement of the **account's** capabilities (its `sub` is the hello's `user`). The phone uses it only
to decide what to show, and refreshes it with `GET /api/auth/grant` (BtwDevice-signed). The server checks the
allowlist on `/api/device/compose` whatever the phone holds: a refusal is `403 capability_required`. Format, keys
and verification: [CAPABILITIES.md](CAPABILITIES.md).

## Share and fetch from the phone (CID-only links)

`PUT /api/shares/<cid>` is the short link's write side (DESIGN.md "Short links"). A paired phone signs it like every device
request and it runs **as the pairing owner**: JSON `{text, license?, forked_from?, credits?, name?}`, public programs only, counted
per account (`-share-hour`, 60) and per address. The answer carries `short_url` (`https://btw.bitwrap.io/p/<CID>`),
`short_beats_url` (`https://beats.bitwrap.io/p/<CID>`) and `short_social_url`. Fetching by CID needs no signature at all:
`GET /api/programs/<cid>` is public (`{cid, text, meta}` with the rights), and the phone recomputes the CID from the text itself
before it plays (a store that answers another program under a CID is refused). A CID alone does not carry a program: a CID the
site has not stored is `404`; the self-sealing link is what works anywhere.

## Not done (decide)

- The phone does not countersign with its own did:pkh wallet identity. That would need a biometric
  prompt at pairing; the server would accept an optional `wallet` field on the claim.
- An Android App Link for `https://<site>/pair` (opening the app straight from the camera)
  needs `/.well-known/assetlinks.json` with the release key's fingerprint.

## Privacy

A program composed from a paired phone is stored publicly under CC0-1.0 like any other, and the answer says so (`notice`,
`license`). The prompt goes to a third-party model. See `/privacy`.

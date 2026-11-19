# Moving the site to another domain

The site is identified by `site_id` (`<data>/site.json`, made on first start), not by its host. A phone signs
`btw-pair/2` messages that name the id, a browser sign-in names the host only for the minute it takes, and
every address the server prints comes from one flag. A move is therefore: copy the data, start the same site
under a new name, tell the old name it has moved.

| flag / env | meaning |
|---|---|
| `-public-url` / `BTW_PUBLIC_URL` | the origin people use; every link, card, QR code and `og:` tag is built from it |
| `-alt-origins` / `BTW_ALT_ORIGINS` | other origins this site answers for (the old name). Accepted as the host in `btw-pair/1` signatures and as a browser `Origin` |
| `-moved-to` / `BTW_MOVED_TO` | set on the OLD server: phones get a `moved` event on their stream, the page shows a banner, `/.well-known/btw-site` carries `moved_to` |
| `-site-id` / `BTW_SITE_ID` | normally unset; a new box with an empty data dir can be told the id of the box it replaces (a different id than the one on disk is refused) |

What is host-free and travels with `data/`: `site.json`, `devices.json` (a phone's public key and owner),
`tokens.json` (opaque MCP tokens, stored hashed), `session.secret`, the programs store. What is not: the browser
cookie (everyone signs in again), a browser-key (Ed25519) account's key, which lives in the browser's IndexedDB
for the OLD origin (export it from the sign-in panel before the old name goes dark; wallet accounts need nothing).

## Order

1. **New name ready.** DNS, a certificate, an nginx vhost. The vhost is the old one with the name replaced:
   `sed 's/btw\.bitwrap\.io/NEW/g' btwsite/deploy/nginx/btw.bitwrap.io.conf`.
2. **Phones first.** Ship the djandroid build that trusts the new origin and follows a `moved` event
   (it verifies that `NEW/.well-known/btw-site` names the same `site_id` before it switches). Do not take the
   old name down before enough phones have it.
3. **Copy the data.** Stop writes on the old box, `rsync -a data/ NEW_BOX:data/` (SQLite files with `.backup`,
   never `cp` a live WAL; this server's files are JSON and the programs store, so `rsync` is fine once it is stopped
   or after a quiet moment). Check `site.json` arrived: the id must not change.
4. **Start the new server** with `-public-url https://NEW -alt-origins https://OLD`. `curl https://NEW/.well-known/btw-site`
   must show the same `site_id` as `https://OLD/.well-known/btw-site`.
5. **Old server in moved mode.** Restart it with `-moved-to https://NEW`. Online phones follow within seconds
   (the notice comes on their open stream); the page offers a "Go to the new address" button.
6. **Cut over the front door.** Once the stream shows few phones still on the old name, swap the old vhost for
   `nginx/redirect.conf.tmpl` (`sed -e 's/@OLD@/btw.bitwrap.io/g' -e 's/@NEW@/NEW/g'`). It 308s everything
   and keeps `/.well-known/btw-site`, so a phone that was away learns the new origin when it comes back, and
   every share link (`/#CID.packed`, `/c/CID.packed`) keeps opening.
7. **Retire the old service**, not the name: stop the old process and use the console's `retire-an-app` flow
   (archive and hash-verify `data/` first). Keep the old name's DNS and certificate renewing as long as the
   redirect lives (a year at least).
8. **MCP clients** stored `https://OLD/mcp` in their config; the 308 carries a POST, but tell users to re-add
   `https://NEW/mcp`. Their bearer tokens are valid on the new server.

A phone that never got the new build re-pairs by QR code (one scan; its key is kept). Nothing here needs it.

## Checks that fail loudly

- `go test ./internal/btwsite/server -run 'Portable|Moved|PairV|SiteDoc|AltOrigins'` pins the move behaviour.
- No host literal may be added outside tests, docs and the `-public-url` default: `scripts/btw-host-literals.sh`.

# Android App Links for beatscript.app

The Share panel's QR holds `https://beatscript.app/p#<CID>.<packed>`. The BeatScript app (package `app.beatscript`)
claims `https://beatscript.app/p` and opens that form with no network, verifying the CID. On Android 12+ a link opens
in the app only if the host proves the app is its own, by serving `/.well-known/assetlinks.json`; without it the
phone's camera opens the browser (the page at `/p#...` still works there).

## Serving it

```
btwsite -assetlinks-file /home/ubuntu/btw-assetlinks.json      # or BTW_ASSETLINKS_FILE
```

- No file configured: `/.well-known/assetlinks.json` is a 404, as before.
- The file is read on each request (add a key without a restart) and must be valid JSON; the flag is refused at start
  if it is not. Served `application/json`, 200, never a redirect (the verifier does not follow one).
- Start from `assetlinks.example.json` (same directory). Keep the real file outside the repo on pflow.dev.

## Expected content

`sha256_cert_fingerprints` lists every key an install can be signed with:

| Build | Fingerprint (SHA-256) |
|---|---|
| Direct download (CDN) build, release key, CN=djandroid | `B6:64:E3:34:FB:56:4F:12:C0:0B:74:38:94:1E:99:1A:64:5A:DF:47:26:AD:BB:18:CF:01:35:2E:55:8A:8D:47` |
| Google Play (app-signing key) | **PLACEHOLDER — Matt must copy it from Play Console › Release › Setup › App integrity › App signing key certificate › SHA-256.** Play re-signs uploads, so the upload key is not it. Do not guess; until pasted, Play installs open links in the browser. |

## Hosts

Only `beatscript.app` needs the file: the app autoVerifies that host alone.

`btwsite/deploy/nginx/btw.bitwrap.io.redirect.conf` needs **no change**. It proxies only `/api/`, `/mcp` and `/context/`;
`/.well-known/` falls into `location /` and is 301'd to beatscript.app. Android verifies the host it claims and does not
need the file on btw.bitwrap.io, so leaving the redirect is correct and keeps "served on beatscript.app only". If the app
ever claims `btw.bitwrap.io/p` or `beats.bitwrap.io/p` with autoVerify, each of those hosts must itself serve the file
(on btw.bitwrap.io that means adding `location /.well-known/assetlinks.json` proxying to 127.0.0.1:18097 above `location /`).

## Check

```
curl -sI https://beatscript.app/.well-known/assetlinks.json     # 200, content-type: application/json
curl -s "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://beatscript.app&relation=delegate_permission/common.handle_all_urls"
adb shell pm get-app-links app.beatscript                        # beatscript.app: verified
```

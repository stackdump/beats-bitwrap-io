# Capabilities and the signed capability grant (`btw-cap+jws`)

A **capability** is something an account may do beyond being signed in. Today there is one: `compose` (the LLM).
The server keeps an admin-managed allowlist, and gives clients a **grant**: a signed statement of an account's
capabilities that a client (the Android app, the page, an MCP client) can check offline, to decide what to *show*.

**The grant never decides what is allowed.** `/api/compose`, `/api/device/compose` and any later LLM route check the
allowlist (and the existing limits and spend cap) on every request, whatever grant the client holds. A forged or
stale grant can only show a button that the server then refuses (`403 capability_required`).

Implementation: djrust-vevr-se `crates/btwserve/src/caps.rs`. Test vectors: `crates/btwserve/src/caps/vectors.json`.

## The published keys

`GET /.well-known/btw-capabilities.json` (public, CORS `*`, `Cache-Control: public, max-age=300`):

```json
{"issuer":"https://beatscript.app","typ":"btw-cap+jws","keys":[{"kid":"3f1c…","alg":"Ed25519","pub":"<base64url, 32 bytes>"}]}
```

- `kid`: the first 16 hex digits of SHA-256 of the raw 32-byte public key.
- `pub`: the raw Ed25519 public key, base64url without padding.
- There can be more than one key. The first one signs; the others are earlier keys, still published so their grants
  verify until they expire. **Choose the key by the grant's `kid`, never by position.** Re-fetch the set when you
  meet an unknown `kid` (at most once per grant), and cache it for no more than a day.

Server side: the signing key is `<data>/cap-signing.key` (a hex Ed25519 seed, 0600, made at the first start), separate
from `session.secret`. To rotate it, rename it to `cap-signing.prev.key` and restart: a new key is made and signs, and
the previous one stays published. Delete `cap-signing.prev.key` 7 days later, once the last grant it signed has
expired.

## The grant

A compact JWS-like string: `base64url(header) "." base64url(payload) "." base64url(signature)`, base64url without
padding.

- header: `{"alg":"EdDSA","kid":"<kid>","typ":"btw-cap+jws"}`
- payload: `{"iss":"https://beatscript.app","sub":"<account id>","caps":["compose"],"iat":<unix s>,"exp":<unix s>,"jti":"<random>"}`
- signature: Ed25519 over the ASCII bytes `<base64url header>.<base64url payload>`, exactly as they appear in the string.
  Do not re-serialize the JSON.

`sub` is the **account** id, the same string as `/api/auth/me`'s `user.id` and the pairing hello's `user`:
`ed25519:<64 lowercase hex>` for a browser-key account, `eip155:0x<40 hex>` for a wallet. Treat it as opaque. For a
paired phone, it is the account that paired it, **not** the phone's own device key.

`caps` is sorted and may be empty (`[]`): an identity not on the allowlist has no capabilities. The lifetime is 7
days (`exp = iat + 604800`).

### Verifying (what a client does)

1. Split on `.` into exactly 3 parts and base64url-decode each.
2. The header must have `alg` `EdDSA` and `typ` `btw-cap+jws`. Refuse anything else, including `alg: none`.
3. Find the published key whose `kid` equals the header's `kid` and whose `alg` is `Ed25519`. With no such key, refuse.
4. Verify the signature over `part0 + "." + part1`. If it fails, refuse.
5. Parse the payload. Refuse when `iss` is not `https://beatscript.app`, when `now >= exp`, or when `iat` is more
   than 5 minutes in the future.
6. Check that `sub` is the account you think you are signed in as.

Refuse means: show no capabilities, and ask for a new grant when you are online.

## Getting a grant

| where | how it authenticates | answer |
|---|---|---|
| `GET /api/auth/grant` | the session cookie, `Authorization: Bearer btw_…`, or a paired phone's `Authorization: BtwDevice …` signed over `GET /api/auth/grant` and an empty body | `{"caps":[…],"exp":<unix>,"grant":"…"}` |
| `POST /api/pair/claim` and `GET /api/device/me` | (pairing / the device signature) | the hello, plus `"caps":[…]` and `"grant":"…"` for the paired account |
| `GET /api/auth/me` | cookie or `btw_` token | `{"user":{…},"caps":[…]}` (caps only; no grant) |
| `POST /oauth/token` | OAuth (see below) | the token response, plus `"caps":[…]` and `"cap_grant":"…"` |

A phone should fetch a new grant with `GET /api/auth/grant` (BtwDevice) when `exp` is less than a day away, and after
the hello whenever it reconnects.

## The allowlist (admin)

`<data>/caps.json`:

```json
{"enforce": false, "identities": {"ed25519:<hex>": ["compose"]}}
```

- `identities`: account id → capability list. Only known capability names count (`compose`).
- `enforce`: when `false` (the default, and what a missing file means), every signed-in account may compose, as
  before, under the existing per-user limits, kill switch and daily spend cap. The grant still reports only the
  allowlist, so a client can already gate its UI on it. When `true`, the server refuses compose to any account whose
  list does not have `compose` (`403 capability_required`).
- Edit it through the admin endpoint (`Authorization: Bearer $BTW_ADMIN_TOKEN`). A hand edit is picked up on the next
  request.
  - `GET /api/admin/caps` returns the file.
  - `POST /api/admin/caps {"identity":"ed25519:…","caps":["compose"]}` sets one identity. An empty list removes it.
  - `POST /api/admin/caps {"enforce":true}` turns enforcement on.

## OAuth (MCP clients)

`/mcp` follows the MCP authorization spec, so claude.ai and Claude Code can connect without a pasted token:

- `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` (RFC 9728): the resource is
  `https://beatscript.app/mcp`.
- `/.well-known/oauth-authorization-server` (RFC 8414).
- `/oauth/register` is dynamic client registration (RFC 7591). Clients are public: `token_endpoint_auth_method: none`.
- Authorization code with PKCE S256 only. There is no implicit grant and no `plain`. The redirect URI must match a
  registered one exactly.
- `/oauth/authorize` uses the site's own sign-in (the same challenge text as the page), then shows a consent screen
  naming the client and its redirect URI.
- `/oauth/token`: access tokens `bto_…` last 1 h and are bound to `https://beatscript.app/mcp` (only `/mcp` accepts
  them). Refresh tokens `btr_…` last 30 days and rotate on use; presenting a used refresh token again revokes the
  whole connection.
- `/oauth/revoke` (RFC 7009).
- A 401 from `/mcp` carries `WWW-Authenticate: Bearer resource_metadata="https://beatscript.app/.well-known/oauth-protected-resource/mcp", scope="mcp"`.
  `/mcp` answers 401 for a bad, expired or revoked token, and for an anonymous call of a tool that needs an account.
  Anonymous read-only tools still work without one.
- Pasted `btw_` tokens from the MCP panel keep working everywhere they worked before.
- The MCP panel lists connections (`GET /api/auth/clients`) and disconnects one (`DELETE /api/auth/clients/<id>`).
  "Revoke all my tokens" (`DELETE /api/auth/token`) also disconnects every OAuth client (`oauth_revoked` in its answer).
- Store: `<data>/oauth.json` (clients, and grants by token hash; 0600). Codes are in memory for 10 minutes.

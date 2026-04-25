# Worked share examples

Drop-in starting points for `curl -d @<name>.json http://localhost:8080/api/project` (sequencer load when running with `-authoring`) or `… /o/{cid}` (direct share-store seal).

| File | What it shows |
|---|---|
| `minimal.json` | Smallest valid share — just `genre` + `seed`. CID-stable across producers. |
| `overrides.json` | Realistic share with `tempo` / `fx` / `feel` / `tracks` overrides on top of `(genre, seed)`. |
| `hand-authored.json` | Raw-`nets` share — bespoke topology, no composer involvement. Template for porting an external sequence. |
| `macro-orchestrated.json` | 118 BPM, 6 nets: kick / snare / bass / 16-step lead / pad + **conductor** control net. 64-step conductor fires `reverb-wash` → `ping-pong` → `sweep-lp` (4-bar drain over a 4-bar cycle — exactly drain-balanced). Reference for baking macros into the score instead of performing them live. |
| `voltage-rush.json` | 140 BPM darker cousin, 7 nets: 808 kick / clap-snare / 8-step hat / reese bass / rave-stab chords / sync-lead arp + a 64-step conductor firing `riser` → `beat-repeat` → `sweep-hp` (4-bar drain / 4-bar cycle). |
| `phantom-aqueduct.json` | 128 BPM long-form **A/B riff-variant** demo. 9 nets including `bass-A`/`bass-B` and `lead-A`/`lead-B` pairs (shared `riffGroup`), kick/snare/hat/pad throughout, and a 64-step conductor that fires `activate-slot` to flip variants every 4 bars plus a `riser` at the top and a `reverb-wash` at the transition. Add `"structure": "extended"` + `"arrangeSeed": 42` to the envelope to auto-expand this 9-net source into a 95-net, 9-section track at load time. |

## Sealing a payload from an agent (no Go binary required)

Canonical JSON + CIDv1 (dag-json, sha256) + base58btc, then PUT to `/o/{cid}`. The server re-canonicalizes and verifies the CID match before storing.

```python
import hashlib, json, urllib.request

payload = { "@context": "https://beats.bitwrap.io/schema/beats-share",
            "@type": "BeatsShare", "v": 1,
            "genre": "custom", "seed": 0, "nets": {...} }

# Canonical JSON: recursively sort object keys, compact separators.
def canon(v):
    if isinstance(v, dict):  return {k: canon(v[k]) for k in sorted(v)}
    if isinstance(v, list):  return [canon(x) for x in v]
    return v
canonical = json.dumps(canon(payload), separators=(',', ':'), ensure_ascii=False).encode()

# CID: "z" + base58btc(0x01 0xa9 0x02 0x12 0x20 + sha256(canonical))
h = hashlib.sha256(canonical).digest()
cid_bytes = bytes([0x01, 0xa9, 0x02, 0x12, 0x20]) + h
alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = int.from_bytes(cid_bytes, 'big')
out = ""
while n: n, r = divmod(n, 58); out = alphabet[r] + out
cid = "z" + ("1" * next((i for i, b in enumerate(cid_bytes) if b), 0)) + out

# PUT the bytes; server re-canonicalizes + verifies the CID match.
urllib.request.urlopen(urllib.request.Request(
    f"https://beats.bitwrap.io/o/{cid}",
    data=canonical, method="PUT",
    headers={"Content-Type": "application/ld+json"}))

print(f"https://beats.bitwrap.io/?cid={cid}")
```

**Local-binary alternative.** With `./beats-bitwrap-io -authoring` running, `POST /api/project-share {"mirror":["https://beats.bitwrap.io"]}` wraps the currently-loaded project in a share envelope, seals locally, and fans out the PUT to every listed host in one call. Convenience only — the Python recipe is the canonical way and works from anywhere.

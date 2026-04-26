#!/usr/bin/env python3
"""Compute the CID of a share-v1 envelope and (optionally) PUT it to a host.

  ./scripts/seal-share.py examples/metronome.json
  ./scripts/seal-share.py examples/metronome.json --host https://beats.bitwrap.io
  ./scripts/seal-share.py examples/metronome.json --host http://localhost:18090 --quiet

Prints the CID on stdout. With --host, PUTs and prints the play URL too.
Mirror of the canonical Python recipe in examples/README.md.
"""
import argparse, hashlib, json, pathlib, sys, urllib.request

def canon(v):
    if isinstance(v, dict): return {k: canon(v[k]) for k in sorted(v)}
    if isinstance(v, list): return [canon(x) for x in v]
    return v

def cid_of(canonical: bytes) -> str:
    h = hashlib.sha256(canonical).digest()
    cid_bytes = bytes([0x01, 0xa9, 0x02, 0x12, 0x20]) + h
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    n = int.from_bytes(cid_bytes, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = alphabet[r] + out
    leading = next((i for i, b in enumerate(cid_bytes) if b), 0)
    return "z" + ("1" * leading) + out

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("payload", type=pathlib.Path, help="Path to share-v1 JSON envelope")
    ap.add_argument("--host", help="Seal host (e.g. https://beats.bitwrap.io). Omit to compute CID only.")
    ap.add_argument("--quiet", action="store_true", help="Print only the CID (no URLs, no byte count)")
    args = ap.parse_args()

    payload = json.loads(args.payload.read_text())
    canonical = json.dumps(canon(payload), separators=(",", ":"), ensure_ascii=False).encode()
    cid = cid_of(canonical)

    if args.quiet:
        print(cid)
    else:
        print(f"CID:   {cid}")
        print(f"BYTES: {len(canonical)}")

    if args.host:
        host = args.host.rstrip("/")
        req = urllib.request.Request(
            f"{host}/o/{cid}",
            data=canonical, method="PUT",
            headers={"Content-Type": "application/ld+json"},
        )
        try:
            with urllib.request.urlopen(req) as resp:
                code = resp.status
        except urllib.error.HTTPError as e:
            print(f"PUT failed: HTTP {e.code} {e.reason}", file=sys.stderr)
            sys.exit(1)
        if not args.quiet:
            print(f"PUT:   HTTP {code}")
            print(f"PLAY:  {host}/?cid={cid}")
            print(f"AUDIO: {host}/audio/{cid}.webm")

if __name__ == "__main__":
    main()

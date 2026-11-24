#!/usr/bin/env python3
"""Pin beats.bitwrap.io to a BeatScript authority release, and prove it has not drifted.

BeatScript (beatscript.app, github.com/stackdump/beatscript) is the authority for the language and its vocabulary;
beats adopts it. This script holds the pin (beatscript-authority.lock) the way pflow-js.lock holds the shared JS:

  sync   [DIR]   resolve internal/beatscript/used-terms.txt against a beatscript checkout (default $BEATSCRIPT or
                 ../beatscript) and rewrite the lock: the release's version, its source commit, the sha256 of the four
                 authority files beats consumes, and every term beats refers to, with what the authority says it is.
  verify DIR     the lock against that checkout (the files' bytes and every term). Fails on any difference.
  status         the lock against what https://beatscript.app serves now. The context is immutable and must match; the
                 ontology and grammar may lag the repository (the deploy is behind main): said, and failing only if a
                 term beats refers to is not served.
  (check, the offline half, is `go test ./internal/beatscript`: the Authority* constants equal the lock, every term the
   code can emit is in used-terms.txt and the lock.)

No authority text is copied into beats: the lock holds hashes, names and the one-word kind of each term.
"""
import hashlib, json, os, re, subprocess, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCK = os.path.join(ROOT, "beatscript-authority.lock")
USED = os.path.join(ROOT, "internal", "beatscript", "used-terms.txt")
NS = "https://beatscript.app/ontology/ns#"
BASE = "https://beatscript.app"
# where each consumed file is, in the checkout and live
FILES = {
    "ontology-manifest": ("crates/beatscript-serve/ontology/release/manifest.json", "/ontology/release/manifest.json"),
    "ontology-ns.nt": ("crates/beatscript-serve/ontology/release/ns.nt", "/ontology/release/ns.nt"),
    "context": ("docs/beatscript-context-v1.jsonld", "/context/beatscript-v1.jsonld"),
    "grammar": ("crates/djlive/grammar.ebnf", "/grammar.ebnf"),
}
RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"


def sha(b):
    return hashlib.sha256(b).hexdigest()


def used():
    iris, keys = [], []
    for line in open(USED):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        kind, val = line.split(None, 1)
        (iris if kind == "iri" else keys).append(val)
    return sorted(iris), sorted(keys)


def kinds(nt_bytes, iris):
    """The rdf:type local name of each IRI, from N-Triples (one triple a line). Missing IRI -> None."""
    want = set(iris)
    out = {}
    for line in nt_bytes.decode().splitlines():
        m = re.match(r"<([^>]+)> <([^>]+)> <([^>]+)> \.$", line)
        if m and m.group(1) in want and m.group(2) == RDF_TYPE:
            t = m.group(3)
            if t.startswith(NS):
                out[m.group(1)] = t[len(NS):]
            elif m.group(1) not in out:
                out[m.group(1)] = t.rsplit("#", 1)[-1].rsplit("/", 1)[-1]
    # a subject with any triple counts as present
    for line in nt_bytes.decode().splitlines():
        m = re.match(r"<([^>]+)> ", line)
        if m and m.group(1) in want and m.group(1) not in out:
            out[m.group(1)] = "-"
    return out


def ctx_terms(ctx_bytes, keys):
    c = json.loads(ctx_bytes)["@context"]
    out = {}
    for k in keys:
        v = c.get(k)
        out[k] = None if v is None else (v if isinstance(v, str) else v.get("@id"))
    return out


def read_lock():
    d = {"sha256": {}, "term": []}
    for line in open(LOCK):
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        f = line.split()
        if f[0] == "sha256":
            d["sha256"][f[1]] = f[2]
        elif f[0] == "term":
            d["term"].append(f[1:])
        else:
            d[f[0]] = " ".join(f[1:])
    return d


def git(d, *a):
    return subprocess.check_output(["git", "-C", d, *a], text=True).strip()


def checkout_files(d):
    return {k: open(os.path.join(d, p[0]), "rb").read() for k, p in FILES.items()}


def sync(d):
    d = os.path.abspath(d)
    files = checkout_files(d)
    man = json.loads(files["ontology-manifest"])
    iris, keys = used()
    k = kinds(files["ontology-ns.nt"], iris)
    c = ctx_terms(files["context"], keys)
    bad = [i for i in iris if i not in k] + [x for x in keys if not c[x]]
    if bad:
        sys.exit("sync: the authority has no term for: " + ", ".join(bad))
    commit = git(d, "rev-parse", "HEAD")
    dirty = git(d, "status", "--porcelain", "--", *[p[0] for p in FILES.values()])
    if dirty:
        sys.exit("sync: the checkout has uncommitted changes to the authority files; pin a commit")
    out = [
        "# beats.bitwrap.io's pin of the BeatScript authority. Written by scripts/beatscript-authority.sh sync; do not edit.",
        "# BeatScript is the authority, beats the adopter (docs/BEATSCRIPT-ADOPTION.md). Hashes, names and kinds only: no authority text.",
        "authority beatscript",
        "source https://github.com/stackdump/beatscript " + commit,
        "ontology-version " + man["version"],
        "ontology-namespace " + man["namespace"],
        "ontology-version-iri " + man["version_iri"],
        "context-url " + BASE + FILES["context"][1],
        "grammar-url " + BASE + FILES["grammar"][1],
    ]
    out += ["sha256 %s %s" % (n, sha(files[n])) for n in FILES]
    out += ["term iri %s %s" % (i, k[i]) for i in iris]
    out += ["term ctx %s %s" % (x, c[x]) for x in keys]
    open(LOCK, "w").write("\n".join(out) + "\n")
    print("synced to beatscript %s: ontology %s, %d terms" % (commit[:7], man["version"], len(iris) + len(keys)))


def compare(label, lock, files, iris, keys):
    """Differences between the lock and a set of authority bytes. Returns (hard, soft)."""
    hard, soft = [], []
    for n in FILES:
        if sha(files[n]) != lock["sha256"].get(n):
            (hard if n == "context" else soft).append("%s: %s has %s, the lock %s" % (n, label, sha(files[n])[:12], (lock["sha256"].get(n) or "-")[:12]))
    k = kinds(files["ontology-ns.nt"], iris)
    c = ctx_terms(files["context"], keys)
    locked = {(t[0], t[1]): t[2] if len(t) > 2 else "" for t in lock["term"]}
    for i in iris:
        if i not in k:
            hard.append("term %s is not in %s" % (i, label))
        elif locked.get(("iri", i)) != k[i]:
            soft.append("term %s is %s in %s, %s in the lock" % (i, k[i], label, locked.get(("iri", i))))
    for x in keys:
        if not c[x]:
            hard.append("context key %s is not in %s" % (x, label))
        elif locked.get(("ctx", x)) != c[x]:
            soft.append("context key %s is %s in %s, %s in the lock" % (x, c[x], label, locked.get(("ctx", x))))
    return hard, soft


def verify(d):
    lock = read_lock()
    d = os.path.abspath(d)
    iris, keys = used()
    files = checkout_files(d)
    hard, soft = compare("the checkout", lock, files, iris, keys)
    commit = git(d, "rev-parse", "HEAD")
    src = lock.get("source", "").split()[-1]
    if commit != src:
        soft.append("the checkout is at %s, the lock pins %s" % (commit[:7], src[:7]))
    for m in hard + soft:
        print("DRIFT", m)
    if hard or soft:
        sys.exit(1)
    print("beats is pinned to exactly this checkout (%s, ontology %s)" % (commit[:7], lock["ontology-version"]))


def fetch(path):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "beats-bitwrap-io beatscript-authority"})
    return urllib.request.urlopen(req, timeout=30).read()


def status():
    lock = read_lock()
    iris, keys = used()
    files = {n: fetch(p[1]) for n, p in FILES.items()}
    live = json.loads(files["ontology-manifest"])["version"]
    hard, soft = compare("beatscript.app", lock, files, iris, keys)
    print("pinned: ontology %s at beatscript %s" % (lock["ontology-version"], lock["source"].split()[-1][:7]))
    print("live:   ontology %s" % live)
    for m in soft:
        print("LAG  ", m)
    for m in hard:
        print("DRIFT", m)
    if not hard and not soft:
        print("live serves exactly what beats is pinned to")
    elif not hard:
        print("the live deploy differs from the pin, and every term beats refers to is served")
    sys.exit(1 if hard else 0)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    arg = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("BEATSCRIPT", os.path.join(ROOT, "..", "beatscript"))
    if cmd == "sync":
        sync(arg)
    elif cmd == "verify":
        verify(arg)
    elif cmd == "status":
        status()
    else:
        sys.exit(__doc__)

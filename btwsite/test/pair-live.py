#!/usr/bin/env python3
"""pair-live.py: the btw-pair/1 flow end to end against a running server (btwsite/PAIRING.md).

    python3 btwsite/test/pair-live.py [https://btw.bitwrap.io]

A throwaway browser-key user signs in, shows a pairing code, a throwaway phone key claims it, opens the
device stream, the "page" pushes a program and a stop, the phone reports, the page sees it, the page
unpairs and the phone's key stops working. Needs the `cryptography` package. Leaves nothing behind
except an unused sign-in identity (identities are free).
"""
import base64, hashlib, json, sys, threading, time, urllib.request, urllib.error, queue
from http.cookiejar import CookieJar
from urllib.parse import urlparse
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://btw.bitwrap.io").rstrip("/")
HOST = urlparse(BASE).netloc
UA = {"User-Agent": "Mozilla/5.0 (btw pair-live test)"}

jar = CookieJar()
web = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
raw = urllib.request.build_opener()
fails = 0


def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def pub(k): return k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def call(opener, method, path, body=None, headers=None):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    h = dict(UA, **(headers or {}))
    if data is not None: h["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with opener.open(req, timeout=20) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t


def check(ok, what):
    global fails
    print(("  ok   " if ok else " FAIL  ") + what)
    if not ok: fails += 1


def signed(k, dev, method, path, body=b""):
    ts = int(time.time() * 1000)
    msg = f"btw-pair/1 request\nhost: {HOST}\ndevice: {dev}\nmethod: {method}\npath: {path}\nts: {ts}\nbody: {hashlib.sha256(body).hexdigest()}"
    return {"Authorization": f"BtwDevice {dev}.{ts}.{b64u(k.sign(msg.encode()))}"}


# 1. sign in with a browser key
user = Ed25519PrivateKey.generate()
_, ch = call(web, "GET", "/api/auth/challenge")
st, _ = call(web, "POST", "/api/auth/login", {"type": "ed25519", "address": pub(user).hex(),
                                               "signature": user.sign(ch["message"].encode()).hex(), "nonce": ch["nonce"]})
check(st == 200, f"sign in ({st})")
page = {"Origin": BASE}
# a program the real checker accepts: one of the site's own examples
_, exs = call(raw, "GET", "/api/examples")
ex = (exs.get("examples") if isinstance(exs, dict) else exs)[0]
with raw.open(urllib.request.Request(BASE + f"/examples/{ex['name']}.btw", headers=UA), timeout=20) as r:
    PROG = r.read().decode()

# 2. the page shows a code
st, o = call(web, "POST", "/api/pair", {}, page)
check(st == 200 and o["url"].startswith(BASE + "/pair#") and o["qr"].startswith("data:image/png;base64,"), f"offer ({st})")
pair_id, token = o["url"].split("#", 1)[1].split(".")

# 3. the phone claims it
phone = Ed25519PrivateKey.generate()
key = b64u(pub(phone))
ts = int(time.time() * 1000)
msg = f"btw-pair/1 claim\nhost: {HOST}\npair: {pair_id}\ntoken: {hashlib.sha256(token.encode()).hexdigest()}\nkey: {key}\nname: pair-live test\nts: {ts}"
st, hello = call(raw, "POST", "/api/pair/claim", {"proto": "btw-pair/1", "pair_id": pair_id, "token": token, "key": key,
                                                 "name": "pair-live test", "ts": ts, "sig": b64u(phone.sign(msg.encode()))})
check(st == 200 and hello.get("device_id"), f"claim ({st})")
dev = hello["device_id"]
st, s = call(web, "GET", f"/api/pair/{pair_id}")
check(st == 200 and s["state"] == "paired" and s["device"]["fingerprint"] == hello["fingerprint"], f"the page sees it paired, fingerprint {hello['fingerprint']}")
st, _ = call(raw, "POST", "/api/pair/claim", {"proto": "btw-pair/1", "pair_id": pair_id, "token": token, "key": key,
                                             "name": "x", "ts": ts, "sig": b64u(phone.sign(msg.encode()))})
check(st in (401, 410), f"the code is single use ({st})")

# 4. the phone's stream
events = queue.Queue()
def listen():
    req = urllib.request.Request(BASE + "/api/device/events", headers=dict(UA, **signed(phone, dev, "GET", "/api/device/events")))
    try:
        with raw.open(req, timeout=60) as r:
            ev = None
            for line in r:
                line = line.decode().rstrip("\n")
                if line.startswith("event: "): ev = line[7:]
                elif line.startswith("data: ") and ev:
                    events.put((ev, json.loads(line[6:])))
                    if ev == "unpaired": return
    except Exception as e:
        events.put(("error", str(e)))
threading.Thread(target=listen, daemon=True).start()
def want(name, within=10):
    end = time.time() + within
    while time.time() < end:
        try: ev, d = events.get(timeout=max(0.1, end - time.time()))
        except queue.Empty: break
        if ev == name: return d
        if ev == "error": return None
    return None
check(want("hello") is not None, "the stream says hello")

# 5. the page pushes a program, then a stop
st, r = call(web, "POST", f"/api/devices/{dev}/push", {"type": "eval", "text": PROG, "play": True}, page)
d = want("eval")
check(st == 200 and d and d["text"] == PROG and d["play"], f"push eval ({ex['name']}) reaches the phone ({st} {r if st != 200 else ''})")
st, _ = call(web, "POST", f"/api/devices/{dev}/push", {"type": "stop"}, page)
check(st == 200 and want("stop") is not None, "push stop reaches the phone")
st, _ = call(web, "POST", f"/api/devices/{dev}/push", {"type": "eval", "text": "tempo nonsense ((("}, page)
check(st == 422, f"a program with errors is not sent ({st})")

# 6. the phone reports; the page sees it
body = json.dumps({"cid": (d or {}).get("cid", ""), "playing": True, "section": "intro", "bar": 1, "source": "phone"}).encode()
st, _ = call(raw, "POST", "/api/device/report", body, signed(phone, dev, "POST", "/api/device/report", body))
check(st == 204, f"report ({st})")
st, ds = call(web, "GET", "/api/devices")
mine = [x for x in ds["devices"] if x["id"] == dev]
check(mine and mine[0]["connected"] and mine[0]["state"]["playing"], "the page sees the phone connected and playing")

# 7. unpair from the page
st, _ = call(web, "DELETE", f"/api/devices/{dev}", None, page)
check(st == 204 and want("unpaired") is not None, f"unpair: the stream is told ({st})")
st, _ = call(raw, "GET", "/api/device", None, signed(phone, dev, "GET", "/api/device"))
check(st == 410, f"the phone's key no longer works ({st})")

print(f"{'FAILED' if fails else 'passed'}: {fails} failure(s) against {BASE}")
sys.exit(1 if fails else 0)

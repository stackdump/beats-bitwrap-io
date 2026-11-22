#!/usr/bin/env bash
# Deploy beatscript.app (and btw.bitwrap.io) to pflow.dev, in idempotent steps. The server is btwserve (Rust,
# djrust-vevr-se crates/btwserve), the ~/services entry btw-rust on 127.0.0.1:18099; the Go btwsite server
# (btw-bitwrap, :18097) is retired. btwserve runs from its own checkout of THIS repo (~/Workspace/btw-bitwrap-io,
# BRANCH, default main) for what it reads: btwsite/web (+ wasm), btwsite/examples, btwsite/web/docs and
# internal/btwsite/docs (-docs-src). The main-push webhook (which only touches ~/Workspace/beats-bitwrap-io) is not
# involved: deploying is this script plus cutover.sh, not a push.
#
#   btwsite/deploy/deploy.sh host        checkout $BRANCH (default main) into ~/Workspace/btw-bitwrap-io on the host
#   btwsite/deploy/deploy.sh artifacts   copy what is built from the PRIVATE repo (wasm + sidecars, docs); never in git
#   btwsite/deploy/deploy.sh docs        copy only btwsite/web/docs (BTW.md redacted by scripts/btw-gen-docs.sh, cheatsheet.md)
#   btwsite/deploy/deploy.sh restart     restart btw-rust only, /healthz on :18099
#   btwsite/deploy/deploy.sh upstream    install conf.d/btw-front.conf (upstream btw_front -> :18099) if it is missing
#   btwsite/deploy/deploy.sh retire-go         one time: stop the Go server, drop its btw-bitwrap entry from ~/services
#                                               (backup first; refuses unless btw_front -> :18099 and btwserve is healthy)
#   btwsite/deploy/deploy.sh retire-go-binary  one time, after retire-go: delete the old Go binary ./btw-bitwrap-io
#   btwsite/deploy/deploy.sh nginx-http  port-80 vhost only (ACME), reload
#   btwsite/deploy/deploy.sh cert        certbot (webroot) for btw.bitwrap.io
#   btwsite/deploy/deploy.sh nginx-full  the real btw.bitwrap.io vhost (443 + proxy to btw_front), nginx -t, reload
#   btwsite/deploy/deploy.sh verify      curl the public URL
#   btwsite/deploy/deploy.sh nginx-http-beatscript   beatscript.app + www, port-80 vhost only (ACME), reload
#   btwsite/deploy/deploy.sh cert-beatscript         certbot (webroot), one cert for beatscript.app + www (CERT_NAMES="-d beatscript.app" for apex only; re-run later to --expand); needs DNS A -> this host
#   btwsite/deploy/deploy.sh nginx-full-beatscript   the real beatscript.app vhost (443 + proxy to btw_front), nginx -t, reload
#   btwsite/deploy/deploy.sh verify-beatscript       curl https://beatscript.app
#   btwsite/deploy/deploy.sh nginx-redirect-btw      btw.bitwrap.io becomes a 301 to beatscript.app, except /api/, /mcp, /context/
#                                                    (nginx/btw.bitwrap.io.redirect.conf), nginx -t, reload; restores on failure
#
# The btwserve binary itself is built on workbit (djrust-vevr-se: BTWD_PKG=btwserve scripts/build-btwd-linux.sh) and
# installed by djrust-vevr-se crates/btwserve/deploy/cutover.sh install, which also owns btw-rust's ~/services CMD.
# A full deploy: host, artifacts, then cutover.sh install, then restart (or cutover's own start), then verify-beatscript.
# `build` is kept as a no-op so an older runbook that calls it still runs; `services` and `public-url` (which wrote
# the Go server's ~/services entry) refuse.
#
# beatscript.app is the public origin (since 2026-11-19); btw.bitwrap.io is a second name for the SAME process
# that redirects pages there. Phones paired under btw.bitwrap.io sign that host; btwserve's -legacy-hosts
# btw.bitwrap.io keeps their signatures good, so nobody has to re-pair.
#
# Env: HOST (default pflow.dev), BRANCH (default main). RUST (the private engine checkout) is no longer needed here:
# the wasm is built into btwsite/web/wasm of this checkout. The Gemini key is NEVER read here: it is on the host in
# ~/.env-services/btw-bitwrap (mode 0600; ~/.env-services/btw-rust links to it) and only ever sourced by ~/services.
set -euo pipefail

HOST=${HOST:-pflow.dev}
BRANCH=${BRANCH:-main}
HERE=$(cd "$(dirname "$0")" && pwd)
GO=$(cd "$HERE/../.." && pwd)
REMOTE_DIR='$HOME/Workspace/btw-bitwrap-io'
SERVICE=btw-rust
PORT=18099
DOMAIN=btw.bitwrap.io

step=${1:-}
run() { ssh -o BatchMode=yes "$HOST" "$@"; }

case "$step" in
host)
  run bash -s <<EOS
set -euo pipefail
D=$REMOTE_DIR
if [ ! -d "\$D/.git" ]; then git clone --no-checkout https://github.com/stackdump/beats-bitwrap-io.git "\$D"; fi
cd "\$D"
git fetch origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH"
mkdir -p btwsite/bin btwsite/web/wasm btwsite/web/docs data
ls internal/btwsite/docs
git log --oneline -1
EOS
  ;;
build)
  echo "build: nothing to build on the host. The Go btwsite server is retired; btwserve is built on workbit"
  echo "(djrust-vevr-se: BTWD_PKG=btwserve scripts/build-btwd-linux.sh) and installed by its cutover.sh install."
  ;;
artifacts)
  [ -f "$GO/btwsite/web/wasm/btw_bg.wasm" ] || { echo "no wasm in $GO/btwsite/web/wasm (scripts/build-web-wasm.sh in the Rust worktree)"; exit 1; }
  # precompressed sidecars (6.75 MB -> ~2 MB): btwserve sends btw_bg.wasm.br / .gz with Content-Encoding to a
  # browser that accepts it, and ignores a sidecar older than the wasm. pflow.dev has no brotli, so they are made here.
  W="$GO/btwsite/web/wasm/btw_bg.wasm"
  gzip -9 -n -k -f "$W"
  if command -v brotli >/dev/null; then brotli -q 11 -k -f "$W"; else rm -f "$W.br"; echo "no brotli here: gzip sidecar only"; fi
  ls -l "$W" "$W".*
  rsync -az --delete "$GO/btwsite/web/wasm/" "$HOST:Workspace/btw-bitwrap-io/btwsite/web/wasm/"
  rsync -az "$GO/btwsite/web/docs/" "$HOST:Workspace/btw-bitwrap-io/btwsite/web/docs/"
  run "cd $REMOTE_DIR && chmod -R a+rX btwsite/web/docs btwsite/web/wasm && sha256sum btwsite/web/wasm/btw_bg.wasm && ls btwsite/web/docs btwsite/web/wasm"
  ;;
services|public-url)
  echo "$step: retired with the Go server (it wrote the btw-bitwrap entry in ~/services). btw-rust's entry is" >&2
  echo "written by djrust-vevr-se crates/btwserve/deploy/cutover.sh install." >&2
  exit 1 ;;
retire-go)
  # One time: stop the retired Go server and take its btw-bitwrap entry out of ~/services (backup first). Refuses
  # unless nginx's btw_front names btwserve (:18099) and btwserve answers /healthz. Touches nothing of btw-rust:
  # not its entry, not ~/.env-services/btw-bitwrap (btw-rust's env links to it), not data/. Idempotent.
  run "bash -s -- '${FRONT_CONF:-/etc/nginx/conf.d/btw-front.conf}'" <<'EOS'
set -euo pipefail
conf=$1; f=$HOME/services
grep -Eq '^\s*server 127\.0\.0\.1:18099;' "$conf" || { echo "$conf does not send btw_front to 127.0.0.1:18099: not retiring Go" >&2; exit 1; }
curl -sf -m 5 http://127.0.0.1:18099/healthz >/dev/null || { echo "btwserve on :18099 is not healthy: not retiring Go" >&2; exit 1; }
if ! grep -q '"btw-bitwrap"' "$f"; then echo "no btw-bitwrap entry in $f: already retired"; exit 0; fi
b="$f.bak-retire-go-$(date +%Y%m%d%H%M%S)"; cp -p "$f" "$b"; echo "backup: $b"
"$f" stop btw-bitwrap
python3 - "$f" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
cuts = ['    ["btw-bitwrap"]="18097|beatscript.app|$HOME/Workspace/btw-bitwrap-io"\n',
        next(l for l in s.splitlines(keepends=True) if l.startswith('        btw-bitwrap)'))]
for c in cuts:
    assert s.count(c) == 1, "anchor: " + c.strip()
    s = s.replace(c, "")
o = ' "btw-bitwrap" "btw-rust")'
assert s.count(o) == 1, "SERVICE_ORDER anchor"
s = s.replace(o, ' "btw-rust")')
assert '"btw-bitwrap"' not in s and '\n        btw-bitwrap)' not in s
assert '["btw-rust"]="18099|' in s and '\n        btw-rust)' in s, "btw-rust entry missing"
open(p, "w").write(s); print("removed the btw-bitwrap entry (SERVICES, SERVICE_ORDER, CMD)")
PY
bash -n "$f" && echo "services syntax ok"
diff "$b" "$f" || true
if curl -s -m 3 -o /dev/null http://127.0.0.1:18097/healthz; then echo "something still answers on :18097" >&2; exit 1; fi
echo ":18097 closed"; curl -s -m 5 http://127.0.0.1:18099/healthz; echo
EOS
  ;;
retire-go-binary)
  # One time, after retire-go: delete the Go binary the old build step left in the checkout (untracked, ~21 MB).
  # Refuses while ~/services still names it.
  run "set -e; cd $REMOTE_DIR; if grep -q 'btw-bitwrap-io -addr' ~/services; then echo '~/services still runs ./btw-bitwrap-io: run retire-go first' >&2; exit 1; fi; if [ -e btw-bitwrap-io ]; then ls -l btw-bitwrap-io; rm -f btw-bitwrap-io; echo 'removed ./btw-bitwrap-io'; else echo 'no ./btw-bitwrap-io: already removed'; fi"
  ;;
upstream)
  scp -q "$HERE/nginx/btw-front.conf" "$HOST:/tmp/btw-front.conf"
  run bash -s <<'EOS'
set -euo pipefail
if [ -f /etc/nginx/conf.d/btw-front.conf ]; then grep -n 'server 127' /etc/nginx/conf.d/btw-front.conf; echo "btw-front.conf already there: left as it is"; exit 0; fi
sudo -n install -m 644 /tmp/btw-front.conf /etc/nginx/conf.d/btw-front.conf
if sudo -n nginx -t; then sudo -n systemctl reload nginx && echo "nginx reloaded (upstream btw_front -> 127.0.0.1:18099)"; else
  echo "nginx -t FAILED: removing btw-front.conf"; sudo -n rm -f /etc/nginx/conf.d/btw-front.conf; sudo -n nginx -t; exit 1; fi
EOS
  ;;
docs)
  rsync -az "$GO/btwsite/web/docs/" "$HOST:Workspace/btw-bitwrap-io/btwsite/web/docs/"
  run "cd $REMOTE_DIR && chmod -R a+rX btwsite/web/docs && ls -l btwsite/web/docs && grep -c '/Users/' btwsite/web/docs/BTW.md || true"
  ;;
restart)
  run "~/services stop $SERVICE; sleep 1; ~/services start $SERVICE; sleep 3; curl -s -m 5 http://127.0.0.1:$PORT/healthz; echo"
  ;;
nginx-http)
  scp -q "$HERE/nginx/btw.bitwrap.io.http.conf" "$HOST:/tmp/btw.bitwrap.io"
  run bash -s <<'EOS'
set -euo pipefail
sudo -n install -m 644 /tmp/btw.bitwrap.io /etc/nginx/sites-available/btw.bitwrap.io
[ -e /etc/nginx/sites-enabled/btw.bitwrap.io ] || sudo -n ln -s /etc/nginx/sites-available/btw.bitwrap.io /etc/nginx/sites-enabled/btw.bitwrap.io
sudo -n nginx -t && sudo -n systemctl reload nginx && echo "nginx reloaded (http stage)"
EOS
  ;;
cert)
  run "sudo -n certbot certonly --webroot -w /var/www/acme -d $DOMAIN --non-interactive --agree-tos --keep-until-expiring 2>&1 | tail -15; sudo -n certbot certificates 2>/dev/null | grep -A3 'Name: $DOMAIN'"
  ;;
nginx-full)
  scp -q "$HERE/nginx/btw.bitwrap.io.conf" "$HOST:/tmp/btw.bitwrap.io"
  run bash -s <<'EOS'
set -euo pipefail
[ -f /etc/nginx/conf.d/btw-front.conf ] || { echo 'no /etc/nginx/conf.d/btw-front.conf (upstream btw_front): run deploy.sh upstream first' >&2; exit 1; }
[ -e /etc/letsencrypt/live/btw.bitwrap.io/fullchain.pem ] || sudo -n test -e /etc/letsencrypt/live/btw.bitwrap.io/fullchain.pem
sudo -n cp /etc/nginx/sites-available/btw.bitwrap.io /etc/nginx/sites-available/btw.bitwrap.io.bak.http
sudo -n install -m 644 /tmp/btw.bitwrap.io /etc/nginx/sites-available/btw.bitwrap.io
if sudo -n nginx -t; then sudo -n systemctl reload nginx && echo "nginx reloaded (full vhost)"; else
  echo "nginx -t FAILED: restoring the http-stage vhost"; sudo -n cp /etc/nginx/sites-available/btw.bitwrap.io.bak.http /etc/nginx/sites-available/btw.bitwrap.io; sudo -n nginx -t; exit 1; fi
EOS
  ;;
verify)
  for u in / /healthz /api/info /api/examples /llms.txt /docs/cheatsheet.md /card/default.png; do
    printf '%-24s ' "$u"; curl -s -o /dev/null -m 15 -w '%{http_code} %{content_type}\n' "https://$DOMAIN$u"
  done
  printf 'compose (anonymous)      '; curl -s -m 15 -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{"prompt":"x"}' "https://$DOMAIN/api/compose"
  ;;
nginx-http-beatscript)
  scp -q "$HERE/nginx/beatscript.app.http.conf" "$HOST:/tmp/beatscript.app"
  run bash -s <<'EOS'
set -euo pipefail
sudo -n install -m 644 /tmp/beatscript.app /etc/nginx/sites-available/beatscript.app
[ -e /etc/nginx/sites-enabled/beatscript.app ] || sudo -n ln -s /etc/nginx/sites-available/beatscript.app /etc/nginx/sites-enabled/beatscript.app
sudo -n nginx -t && sudo -n systemctl reload nginx && echo "nginx reloaded (beatscript.app http stage)"
EOS
  ;;
cert-beatscript)
  run "sudo -n certbot certonly --webroot -w /var/www/acme ${CERT_NAMES:--d beatscript.app} --expand --non-interactive --agree-tos --keep-until-expiring 2>&1 | tail -15; sudo -n certbot certificates 2>/dev/null | grep -A3 'Name: beatscript.app'"
  ;;
nginx-full-beatscript)
  scp -q "$HERE/nginx/beatscript.app.conf" "$HOST:/tmp/beatscript.app"
  run bash -s <<'EOS'
set -euo pipefail
[ -f /etc/nginx/conf.d/btw-front.conf ] || { echo 'no /etc/nginx/conf.d/btw-front.conf (upstream btw_front): run deploy.sh upstream first' >&2; exit 1; }
sudo -n test -e /etc/letsencrypt/live/beatscript.app/fullchain.pem
sudo -n cp /etc/nginx/sites-available/beatscript.app /etc/nginx/sites-available/beatscript.app.bak.http
sudo -n install -m 644 /tmp/beatscript.app /etc/nginx/sites-available/beatscript.app
if sudo -n nginx -t; then sudo -n systemctl reload nginx && echo "nginx reloaded (beatscript.app full vhost)"; else
  echo "nginx -t FAILED: restoring the http-stage vhost"; sudo -n cp /etc/nginx/sites-available/beatscript.app.bak.http /etc/nginx/sites-available/beatscript.app; sudo -n nginx -t; exit 1; fi
EOS
  ;;
nginx-redirect-btw)
  scp -q "$HERE/nginx/btw.bitwrap.io.redirect.conf" "$HOST:/tmp/btw.bitwrap.io"
  run bash -s <<'EOS'
set -euo pipefail
[ -f /etc/nginx/conf.d/btw-front.conf ] || { echo 'no /etc/nginx/conf.d/btw-front.conf (upstream btw_front): run deploy.sh upstream first' >&2; exit 1; }
sudo -n cp /etc/nginx/sites-available/btw.bitwrap.io /etc/nginx/sites-available/btw.bitwrap.io.bak.proxy
sudo -n install -m 644 /tmp/btw.bitwrap.io /etc/nginx/sites-available/btw.bitwrap.io
if sudo -n nginx -t; then sudo -n systemctl reload nginx && echo "nginx reloaded (btw.bitwrap.io redirects to beatscript.app)"; else
  echo "nginx -t FAILED: restoring the proxy vhost"; sudo -n cp /etc/nginx/sites-available/btw.bitwrap.io.bak.proxy /etc/nginx/sites-available/btw.bitwrap.io; sudo -n nginx -t; exit 1; fi
EOS
  ;;
verify-beatscript)
  for h in beatscript.app; do
    for u in / /healthz /api/info /llms.txt; do
      printf '%-20s %-12s ' "$h" "$u"; curl -s -o /dev/null -m 15 -w '%{http_code} %{content_type}\n' "https://$h$u"
    done
  done
  ;;
*)
  sed -n 2,40p "$0"; exit 2 ;;
esac

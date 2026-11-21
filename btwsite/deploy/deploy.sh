#!/usr/bin/env bash
# Deploy btw.bitwrap.io to pflow.dev from the Mac, in idempotent steps. Conventions: the same as
# windwheel.bitwrap.io (a ~/services tmux window, env in ~/.env-services/<name>, an nginx vhost with a
# Let's Encrypt cert), but from its own checkout (~/Workspace/btw-bitwrap-io, BRANCH, default main), so the
# main-push webhook (which only touches ~/Workspace/beats-bitwrap-io) is not involved: deploying is this script, not a push.
#
#   btwsite/deploy/deploy.sh host        checkout $BRANCH (default main) into ~/Workspace/btw-bitwrap-io on the host
#   btwsite/deploy/deploy.sh build       go build the service on the host
#   btwsite/deploy/deploy.sh artifacts   copy what is built from the PRIVATE repo (btwd, wasm, docs); never in git
#   btwsite/deploy/deploy.sh docs        copy only btwsite/web/docs (BTW.md redacted by scripts/btw-gen-docs.sh, cheatsheet.md)
#   btwsite/deploy/deploy.sh services    add the btw-bitwrap entry to ~/services (backup first) and start it
#   btwsite/deploy/deploy.sh nginx-http  port-80 vhost only (ACME), reload
#   btwsite/deploy/deploy.sh cert        certbot (webroot) for btw.bitwrap.io
#   btwsite/deploy/deploy.sh nginx-full  the real vhost (443 + proxy), nginx -t, reload
#   btwsite/deploy/deploy.sh verify      curl the public URL
#   btwsite/deploy/deploy.sh restart     stop + start the service only
#   btwsite/deploy/deploy.sh nginx-http-beatscript   beatscript.app + www, port-80 vhost only (ACME), reload
#   btwsite/deploy/deploy.sh cert-beatscript         certbot (webroot), one cert for beatscript.app + www (CERT_NAMES="-d beatscript.app" for apex only; re-run later to --expand); needs DNS A -> this host
#   btwsite/deploy/deploy.sh nginx-full-beatscript   the real beatscript.app vhost (443 + proxy to the same backend), nginx -t, reload
#   btwsite/deploy/deploy.sh verify-beatscript       curl https://beatscript.app
#   btwsite/deploy/deploy.sh public-url              make beatscript.app the public origin: the btw-bitwrap CMD in ~/services gets
#                                                    -public-url https://beatscript.app -legacy-hosts btw.bitwrap.io (backup first), restart
#   btwsite/deploy/deploy.sh nginx-redirect-btw      btw.bitwrap.io becomes a 301 to beatscript.app, except /api/, /mcp, /context/
#                                                    (nginx/btw.bitwrap.io.redirect.conf), nginx -t, reload; restores on failure
#
# beatscript.app is the public origin (since 2026-11-19); btw.bitwrap.io is a second name for the SAME process
# (127.0.0.1:18097, no second instance) that redirects pages there. Phones paired under btw.bitwrap.io sign that
# host; -legacy-hosts btw.bitwrap.io keeps their signatures good, so nobody has to re-pair.
#
# Env: HOST (default pflow.dev), BTWD_LINUX (default <RUST>/dist/btwd-linux-x86_64), RUST (the Rust worktree),
# BRANCH (default main). The Gemini key is NEVER read here: it was copied on the host into
# ~/.env-services/btw-bitwrap (mode 0600) and is only ever sourced by ~/services.
set -euo pipefail

HOST=${HOST:-pflow.dev}
BRANCH=${BRANCH:-main}
RUST=${RUST:?set RUST to your checkout of the private engine repo (it holds dist/btwd-linux-x86_64 and the wasm build)}
BTWD_LINUX=${BTWD_LINUX:-$RUST/dist/btwd-linux-x86_64}
HERE=$(cd "$(dirname "$0")" && pwd)
GO=$(cd "$HERE/../.." && pwd)
REMOTE_DIR='$HOME/Workspace/btw-bitwrap-io'
SERVICE=btw-bitwrap
PORT=18097
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
git log --oneline -1
EOS
  ;;
build)
  run bash -s <<EOS
set -euo pipefail
cd $REMOTE_DIR
V=\$(git describe --tags --always --dirty 2>/dev/null || echo dev)
nice -n 10 go build -ldflags "-X beats-bitwrap-io/internal/btwsite/server.Version=\$V" -o btw-bitwrap-io ./cmd/btwsite
ls -l btw-bitwrap-io
EOS
  ;;
artifacts)
  [ -x "$BTWD_LINUX" ] || { echo "no Linux btwd at $BTWD_LINUX (scripts/build-btwd-linux.sh in the Rust worktree)"; exit 1; }
  [ -f "$GO/btwsite/web/wasm/btw_bg.wasm" ] || { echo "no wasm in $GO/btwsite/web/wasm (scripts/build-web-wasm.sh in the Rust worktree)"; exit 1; }
  # precompressed sidecars (6.75 MB -> ~2 MB): the server sends btw_bg.wasm.br / .gz with Content-Encoding to a
  # browser that accepts it, and ignores a sidecar older than the wasm. pflow.dev has no brotli, so they are made here.
  W="$GO/btwsite/web/wasm/btw_bg.wasm"
  gzip -9 -n -k -f "$W"
  if command -v brotli >/dev/null; then brotli -q 11 -k -f "$W"; else rm -f "$W.br"; echo "no brotli here: gzip sidecar only"; fi
  ls -l "$W" "$W".*
  rsync -az "$BTWD_LINUX" "$HOST:Workspace/btw-bitwrap-io/btwsite/bin/btwd"
  rsync -az --delete "$GO/btwsite/web/wasm/" "$HOST:Workspace/btw-bitwrap-io/btwsite/web/wasm/"
  rsync -az "$GO/btwsite/web/docs/" "$HOST:Workspace/btw-bitwrap-io/btwsite/web/docs/"
  run "cd $REMOTE_DIR && chmod 755 btwsite/bin/btwd && chmod -R a+rX btwsite/web/docs btwsite/web/wasm && sha256sum btwsite/bin/btwd btwsite/web/wasm/btw_bg.wasm && ./btwsite/bin/btwd --version && ls btwsite/web/docs btwsite/web/wasm"
  ;;
services)
  run bash -s <<'EOS'
set -euo pipefail
f=$HOME/services
cp -p "$f" "$f.bak.btw-$(date +%Y%m%d%H%M%S)"
python3 - "$f" <<'PY'
import sys,re
p=sys.argv[1]; s=open(p).read()
if '"btw-bitwrap"' in s:
    print("services already has btw-bitwrap"); sys.exit(0)
a='    ["windwheel-bitwrap"]="18096|windwheel.bitwrap.io|$HOME/Workspace/windwheel-bitwrap-io"\n'
assert s.count(a)==1, "SERVICES anchor"
s=s.replace(a, a+'    ["btw-bitwrap"]="18097|beatscript.app|$HOME/Workspace/btw-bitwrap-io"\n')
b='"windwheel" "windwheel-bitwrap")'
assert s.count(b)==1, "SERVICE_ORDER anchor"
s=s.replace(b,'"windwheel" "windwheel-bitwrap" "btw-bitwrap")')
c='        windwheel-bitwrap)CMD="./windwheel-web -port 18096" ;;\n'
assert s.count(c)==1, "case anchor"
s=s.replace(c, c+'        btw-bitwrap)    CMD="./btw-bitwrap-io -addr 127.0.0.1:18097 -btwd ./btwsite/bin/btwd -web btwsite/web -examples btwsite/examples -docs btwsite/web/docs -data ./data -public-url https://beatscript.app -legacy-hosts btw.bitwrap.io -android-beta-url https://play.google.com/apps/testing/app.beatscript" ;;\n')
open(p,'w').write(s); print("patched")
PY
bash -n "$f" && echo "services syntax ok"
EOS
  run "~/services start $SERVICE; sleep 3; ~/services list | grep -E 'SERVICE|btw-bitwrap'; curl -s -m 5 http://127.0.0.1:$PORT/healthz; echo"
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
sudo -n test -e /etc/letsencrypt/live/beatscript.app/fullchain.pem
sudo -n cp /etc/nginx/sites-available/beatscript.app /etc/nginx/sites-available/beatscript.app.bak.http
sudo -n install -m 644 /tmp/beatscript.app /etc/nginx/sites-available/beatscript.app
if sudo -n nginx -t; then sudo -n systemctl reload nginx && echo "nginx reloaded (beatscript.app full vhost)"; else
  echo "nginx -t FAILED: restoring the http-stage vhost"; sudo -n cp /etc/nginx/sites-available/beatscript.app.bak.http /etc/nginx/sites-available/beatscript.app; sudo -n nginx -t; exit 1; fi
EOS
  ;;
public-url)
  run bash -s <<'EOS'
set -euo pipefail
F=$HOME/services
OLD='-public-url https://btw.bitwrap.io"'
NEW='-public-url https://beatscript.app -legacy-hosts btw.bitwrap.io"'
if grep -qF -- "$NEW" "$F"; then echo "already: $NEW"; else
  grep -qF -- "$OLD" "$F" || { echo "no btw-bitwrap CMD with $OLD in $F: change it by hand" >&2; exit 1; }
  cp "$F" "$F.bak.$(date +%Y%m%d%H%M%S)"
  python3 - "$F" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace('-public-url https://btw.bitwrap.io"', '-public-url https://beatscript.app -legacy-hosts btw.bitwrap.io"', 1)
s = s.replace('["btw-bitwrap"]="18097|btw.bitwrap.io|', '["btw-bitwrap"]="18097|beatscript.app|', 1)
open(p, "w").write(s)
PY
  grep -n "btw-bitwrap" "$F"
fi
~/services restart btw-bitwrap
EOS
  ;;
nginx-redirect-btw)
  scp -q "$HERE/nginx/btw.bitwrap.io.redirect.conf" "$HOST:/tmp/btw.bitwrap.io"
  run bash -s <<'EOS'
set -euo pipefail
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
  sed -n 2,28p "$0"; exit 2 ;;
esac

#!/usr/bin/env bash
# Deploy btw.bitwrap.io to pflow.dev from the Mac, in idempotent steps. Conventions: the same as
# windwheel.bitwrap.io (a ~/services tmux window, env in ~/.env-services/<name>, an nginx vhost with a
# Let's Encrypt cert), but from a checkout of the feature BRANCH, so nothing is merged to main and the
# main-push webhook (which only touches ~/Workspace/beats-bitwrap-io) is not involved.
#
#   btwsite/deploy/deploy.sh host        checkout feat/btw-site into ~/Workspace/btw-bitwrap-io on the host
#   btwsite/deploy/deploy.sh build       go build the service on the host
#   btwsite/deploy/deploy.sh artifacts   copy what is built from the PRIVATE repo (btwd, wasm, docs); never in git
#   btwsite/deploy/deploy.sh services    add the btw-bitwrap entry to ~/services (backup first) and start it
#   btwsite/deploy/deploy.sh nginx-http  port-80 vhost only (ACME), reload
#   btwsite/deploy/deploy.sh cert        certbot (webroot) for btw.bitwrap.io
#   btwsite/deploy/deploy.sh nginx-full  the real vhost (443 + proxy), nginx -t, reload
#   btwsite/deploy/deploy.sh verify      curl the public URL
#   btwsite/deploy/deploy.sh restart     stop + start the service only
#
# Env: HOST (default pflow.dev), BTWD_LINUX (default <RUST>/dist/btwd-linux-x86_64), RUST (the Rust worktree),
# BRANCH (default feat/btw-site). The Gemini key is NEVER read here: it was copied on the host into
# ~/.env-services/btw-bitwrap (mode 0600) and is only ever sourced by ~/services.
set -euo pipefail

HOST=${HOST:-pflow.dev}
BRANCH=${BRANCH:-feat/btw-site}
RUST=${RUST:-$HOME/Workspace/.val-worktrees/djrust-vevr-se/btw-web}
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
nice -n 10 go build -ldflags "-X main.version=\$V" -o btw-bitwrap-io ./cmd/btwsite
ls -l btw-bitwrap-io
EOS
  ;;
artifacts)
  [ -x "$BTWD_LINUX" ] || { echo "no Linux btwd at $BTWD_LINUX (scripts/build-btwd-linux.sh in the Rust worktree)"; exit 1; }
  [ -f "$GO/btwsite/web/wasm/btw_bg.wasm" ] || { echo "no wasm in $GO/btwsite/web/wasm (scripts/build-web-wasm.sh in the Rust worktree)"; exit 1; }
  rsync -az --chmod=F755 "$BTWD_LINUX" "$HOST:Workspace/btw-bitwrap-io/btwsite/bin/btwd"
  rsync -az --delete "$GO/btwsite/web/wasm/" "$HOST:Workspace/btw-bitwrap-io/btwsite/web/wasm/"
  rsync -az "$GO/btwsite/web/docs/" "$HOST:Workspace/btw-bitwrap-io/btwsite/web/docs/"
  run bash -c "cd $REMOTE_DIR && sha256sum btwsite/bin/btwd btwsite/web/wasm/btw_bg.wasm && ./btwsite/bin/btwd --version && ls btwsite/web/docs"
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
s=s.replace(a, a+'    ["btw-bitwrap"]="18097|btw.bitwrap.io|$HOME/Workspace/btw-bitwrap-io"\n')
b='"windwheel" "windwheel-bitwrap")'
assert s.count(b)==1, "SERVICE_ORDER anchor"
s=s.replace(b,'"windwheel" "windwheel-bitwrap" "btw-bitwrap")')
c='        windwheel-bitwrap)CMD="./windwheel-web -port 18096" ;;\n'
assert s.count(c)==1, "case anchor"
s=s.replace(c, c+'        btw-bitwrap)    CMD="./btw-bitwrap-io -addr 127.0.0.1:18097 -btwd ./btwsite/bin/btwd -web btwsite/web -examples btwsite/examples -docs btwsite/web/docs -data ./data -public-url https://btw.bitwrap.io" ;;\n')
open(p,'w').write(s); print("patched")
PY
bash -n "$f" && echo "services syntax ok"
EOS
  run "~/services start $SERVICE; sleep 3; ~/services list | grep -E 'SERVICE|btw-bitwrap'; curl -s -m 5 http://127.0.0.1:$PORT/healthz; echo"
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
*)
  sed -n 2,20p "$0"; exit 2 ;;
esac

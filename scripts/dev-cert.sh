#!/bin/sh
# A local certificate authority and a server certificate signed by it, for the dev server over
# https on the LAN (`make dev-lan`): the studio needs a secure context for its AudioWorklet, and
# a LAN address over plain http is not one. Trust the CA once on each device (CLAUDE.md, "LAN
# dev server over https"); the server certificate can be remade for new addresses any time.
#
#   scripts/dev-cert.sh 192.168.1.243 [more IPs or host names...]
#
# Writes to $BEATS_DEV_CERT_DIR (default ~/.config/beats-dev-cert):
#   ca.pem / ca-key.pem      the CA (made once; ca.pem is what devices trust; keep the key private)
#   server.pem / server-key.pem   for -tls-cert / -tls-key, valid for localhost, 127.0.0.1 and
#                            the names given
set -eu
[ $# -ge 1 ] || { echo "usage: $0 <LAN IP or host name>..." >&2; exit 2; }
DIR=${BEATS_DEV_CERT_DIR:-$HOME/.config/beats-dev-cert}
mkdir -p "$DIR"
chmod 700 "$DIR"
cd "$DIR"

if [ ! -f ca.pem ] || [ ! -f ca-key.pem ]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
        -keyout ca-key.pem -out ca.pem -subj "/CN=beats dev CA ($(hostname))" \
        -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
    chmod 600 ca-key.pem
    echo "made a new CA: $DIR/ca.pem (trust it on each device once)"
fi

san="DNS:localhost,IP:127.0.0.1"
for n in "$@"; do
    case "$n" in
        *[!0-9.]*) san="$san,DNS:$n" ;;
        *) san="$san,IP:$n" ;;
    esac
done

openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout server-key.pem -out server.csr -subj "/CN=beats dev server" 2>/dev/null
printf 'subjectAltName=%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n' "$san" > server.ext
# 397 days: the longest a browser accepts for a server certificate
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 397 \
    -extfile server.ext -out server.pem 2>/dev/null
rm -f server.csr server.ext
chmod 600 server-key.pem
echo "server certificate for $san:"
echo "  -tls-cert $DIR/server.pem -tls-key $DIR/server-key.pem"

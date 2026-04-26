#!/usr/bin/env bash
# Generate a short-lived self-signed ECDSA cert for local WebTransport
# testing. Browsers (Chrome/Edge) accept this kind of cert via the
# `serverCertificateHashes` option on `new WebTransport(...)` as long
# as it's ECDSA-P256/P384 and valid for 14 days or less.
#
# Output:
#   certs/key.pem   — PEM-encoded EC private key (P-256)
#   certs/cert.pem  — PEM-encoded self-signed cert (14-day validity)
#
# Also prints the SHA-256 fingerprint in three forms:
#   - colon-hex (what `openssl x509 -fingerprint` prints)
#   - base64 (paste into `serverCertificateHashes`)
#   - byte array (paste into `serverCertificateHashes` as a Uint8Array)
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$DIR"

KEY="$DIR/key.pem"
CRT="$DIR/cert.pem"

openssl ecparam -name prime256v1 -genkey -noout -out "$KEY"

openssl req -new -x509 -key "$KEY" -out "$CRT" -days 14 -sha256 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
  -addext "extendedKeyUsage=serverAuth"

echo
echo "Wrote $KEY"
echo "Wrote $CRT"
echo

FP_HEX=$(openssl x509 -in "$CRT" -noout -fingerprint -sha256 | sed 's/^.*=//')
FP_B64=$(openssl x509 -in "$CRT" -outform DER | openssl dgst -sha256 -binary | base64)
FP_BYTES=$(echo "$FP_HEX" | tr -d ':' | sed 's/../0x&,/g' | sed 's/,$//')

echo "SHA-256 fingerprint (colon-hex): $FP_HEX"
echo "SHA-256 fingerprint (base64):    $FP_B64"
echo "SHA-256 fingerprint (bytes):     [$FP_BYTES]"
echo
echo "On the client:"
echo "  new WebTransport('https://localhost:3001/angelia', {"
echo "    serverCertificateHashes: [{"
echo "      algorithm: 'sha-256',"
echo "      value: new Uint8Array([$FP_BYTES])"
echo "    }]"
echo "  })"

#!/usr/bin/env bash
# Placeholder cert at the exact path certbot will later occupy, so nginx starts
# on first boot instead of crash-looping on a missing ssl_certificate.
set -euo pipefail
DIR="${1:-$(dirname "$0")/certs}"
mkdir -p "$DIR/live/app"
if [ -f "$DIR/live/app/fullchain.pem" ]; then
  echo "cert already present, leaving it alone"
  exit 0
fi
openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
  -keyout "$DIR/live/app/privkey.pem" \
  -out "$DIR/live/app/fullchain.pem" \
  -subj "/CN=placeholder.invalid"
echo "placeholder cert written to $DIR/live/app"

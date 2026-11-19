#!/usr/bin/env bash
# Nightly pg_dump with 7-day rotation. Run from /opt/ultimate via cron.
set -euo pipefail
DIR="${BACKUP_DIR:-/var/backups/gateway}"
mkdir -p "$DIR"
STAMP=$(date +%F-%H%M)
cd "${APP_DIR:-/opt/ultimate}"
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  -f deploy/docker-compose.deploy.yml --profile app \
  exec -T postgres pg_dump -U gateway gateway | gzip > "$DIR/gateway-$STAMP.sql.gz"
find "$DIR" -name 'gateway-*.sql.gz' -mtime +7 -delete
echo "backup wrote $DIR/gateway-$STAMP.sql.gz"

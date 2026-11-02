#!/usr/bin/env bash
# Backs up the database and the app volume (WhatsApp login keys + media). Add to cron, e.g.:
#   0 3 * * * bash /home/ubuntu/wa-listener/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${BACKUP_DIR:-/var/backups/wa-listener}"; mkdir -p "$OUT"; stamp=$(date +%F)
docker compose exec -T db pg_dump -U postgres walistener | gzip > "$OUT/db-$stamp.sql.gz"
docker compose exec -T app tar -C /data -czf - . > "$OUT/appdata-$stamp.tar.gz"
find "$OUT" -type f -mtime +14 -delete
echo "Backups in $OUT"

#!/usr/bin/env bash
# Pull the latest code and redeploy. Run from anywhere: sudo bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
files=(-f docker-compose.yml)
grep -q '^DOMAIN=.\+' .env && files+=(-f docker-compose.caddy.yml)
docker compose "${files[@]}" up -d --build
docker image prune -f >/dev/null

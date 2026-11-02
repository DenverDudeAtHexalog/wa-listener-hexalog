#!/usr/bin/env bash
# One-shot setup for an AWS EC2 box (Ubuntu/Debian or Amazon Linux 2023). Run from the repo folder:
#   sudo bash deploy/setup.sh                       # private: portal reachable via SSH tunnel only
#   sudo DOMAIN=listener.example.com bash deploy/setup.sh   # public HTTPS via Caddy (DNS A record must point here first)
#   sudo BIND=0.0.0.0 bash deploy/setup.sh          # open port 3000 (restrict it in the security group to your IP!)
# Safe to re-run: it keeps an existing .env and just rebuilds/restarts.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
DOMAIN="${DOMAIN:-}"
BIND="${BIND:-127.0.0.1}"

# ---- swap on small instances (npm ci / docker build can run out of memory on 1 GB) -----------
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$mem_mb" -lt 2000 ] && ! swapon --show | grep -q .; then
  echo ">> Low memory ($mem_mb MB): adding a 2 GB swap file"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---- Docker + compose plugin -------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo ">> Installing Docker"
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) curl -fsSL https://get.docker.com | sh ;;
    amzn) dnf install -y docker && systemctl enable --now docker ;;
    *) echo "Unsupported OS '${ID:-?}'. Install Docker + compose plugin manually, then re-run."; exit 1 ;;
  esac
fi
systemctl enable --now docker >/dev/null 2>&1 || true
if ! docker compose version >/dev/null 2>&1; then
  echo ">> Installing docker compose plugin"
  arch=$(uname -m); [ "$arch" = "aarch64" ] || arch=x86_64
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

# ---- .env (created once; secrets are random) ----------------------------------------------------
rand() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }
if [ ! -f .env ]; then
  echo ">> Creating .env"
  if [ -n "$DOMAIN" ]; then
    base="https://$DOMAIN"
  else
    token=$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
    ip=$(curl -s -m 2 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
    base="http://${ip:-localhost}:3000"
  fi
  PORTAL_PW="$(rand 16)"
  cat > .env <<ENV
API_KEY=$(rand 40)
PORTAL_PASSWORD=$PORTAL_PW
DB_PASSWORD=$(rand 24)
PUBLIC_BASE_URL=$base
BIND=$BIND
DOMAIN=$DOMAIN
ENV
  chmod 600 .env
  echo "   Portal password (also saved in .env): $PORTAL_PW"
else
  echo ">> Keeping existing .env"
fi

# ---- start --------------------------------------------------------------------------------------
files=(-f docker-compose.yml)
if [ -n "$DOMAIN" ]; then files+=(-f docker-compose.caddy.yml); fi
echo ">> Building and starting"
docker compose "${files[@]}" up -d --build

echo ">> Waiting for the service to answer"
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:3000/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "${ok:-}" = 1 ] && echo "   Healthy." || { echo "   Not healthy yet. Check: docker compose logs app"; exit 1; }

echo
echo "Done."
if [ -n "$DOMAIN" ]; then
  echo "Portal:  https://$DOMAIN   (Caddy fetches the certificate on first visit; ports 80 and 443 must be open)"
else
  echo "Portal is bound to $BIND:3000."
  [ "$BIND" = "127.0.0.1" ] && echo "From your computer run:  ssh -L 3000:localhost:3000 <user>@<this-server>   then open http://localhost:3000"
fi
echo "API key and portal password are in $(pwd)/.env"

#!/usr/bin/env bash
#
# One-time droplet setup: nginx, the web root, and the site config.
#
#   DROPLET=root@203.0.113.10 ./deploy/setup.sh
#
# Idempotent — safe to re-run, and the way to recover if the droplet's nginx
# config ever gets out of sync. Follow it with deploy/deploy.sh to ship the app.

set -euo pipefail

DROPLET="${DROPLET:?Set DROPLET, e.g. DROPLET=root@203.0.113.10}"
REMOTE_ROOT="${REMOTE_ROOT:-/var/www/components-inventory}"
SITE_NAME="${SITE_NAME:-components-inventory}"

cd "$(dirname "$0")/.."

echo "==> Installing nginx and rsync"
ssh "$DROPLET" "bash -s" <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8
apt-get update -qq
apt-get install -y -qq nginx rsync
systemctl enable --now nginx
EOF

echo "==> Preparing $REMOTE_ROOT"
ssh "$DROPLET" "mkdir -p '$REMOTE_ROOT'"

echo "==> Installing nginx site"
scp -q deploy/nginx.conf "$DROPLET:/etc/nginx/sites-available/$SITE_NAME"
ssh "$DROPLET" "bash -s" <<EOF
set -euo pipefail
ln -sf /etc/nginx/sites-available/$SITE_NAME /etc/nginx/sites-enabled/$SITE_NAME

# Ubuntu ships a site that claims default_server and would otherwise win every
# request on the bare IP, making this app 404.
if [[ -e /etc/nginx/sites-enabled/default ]]; then
  echo "  removing Ubuntu's stock nginx site"
  rm -f /etc/nginx/sites-enabled/default
fi

# Only touch the firewall if it is actually in use.
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  echo "  opening HTTP/HTTPS in ufw"
  ufw allow 'Nginx Full' >/dev/null
fi

nginx -t && systemctl reload nginx
EOF

echo "==> Done. Now ship the app:"
echo "    DROPLET=$DROPLET ./deploy/deploy.sh"

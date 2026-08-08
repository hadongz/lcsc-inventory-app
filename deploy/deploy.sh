#!/usr/bin/env bash
#
# Build locally and ship dist/ to a DigitalOcean droplet over rsync.
#
#   DROPLET=root@203.0.113.10 ./deploy/deploy.sh
#
# Run deploy/setup.sh once first — it installs nginx and the site config.
# This script also re-pushes deploy/nginx.conf every run, so the repo stays the
# source of truth and the droplet can never drift onto a stale config.

set -euo pipefail

DROPLET="${DROPLET:?Set DROPLET, e.g. DROPLET=root@203.0.113.10}"
REMOTE_ROOT="${REMOTE_ROOT:-/var/www/components-inventory}"
SITE_NAME="${SITE_NAME:-components-inventory}"

# Must match the path prefix in deploy/nginx.conf.
BASE_PATH="${BASE_PATH:-/components-inventory/}"

cd "$(dirname "$0")/.."

# Skipping setup looks exactly like a broken build: files land fine and every
# URL 404s. Check before spending time on a build.
echo "==> Preflight"
ssh "$DROPLET" "bash -s" <<EOF
set -euo pipefail
if ! command -v nginx >/dev/null; then
  echo "❌ nginx is not installed. Run: DROPLET=$DROPLET ./deploy/setup.sh" >&2
  exit 1
fi
if [[ ! -e /etc/nginx/sites-enabled/$SITE_NAME ]]; then
  echo "❌ nginx site '$SITE_NAME' is not enabled. Run: DROPLET=$DROPLET ./deploy/setup.sh" >&2
  exit 1
fi
if [[ -e /etc/nginx/sites-enabled/default ]]; then
  echo "❌ Ubuntu's stock nginx site is still enabled and will win every request." >&2
  echo "   Run: DROPLET=$DROPLET ./deploy/setup.sh" >&2
  exit 1
fi
echo "✓ nginx ready"
EOF

echo "==> Building for base $BASE_PATH"
BASE_PATH="$BASE_PATH" npm run build

echo "==> Syncing dist/ to $DROPLET:$REMOTE_ROOT"
# --delete removes stale content-hashed assets from previous deploys.
rsync -az --delete dist/ "$DROPLET:$REMOTE_ROOT/"

echo "==> Syncing nginx config"
scp -q deploy/nginx.conf "$DROPLET:/etc/nginx/sites-available/$SITE_NAME"
ssh "$DROPLET" 'nginx -t && systemctl reload nginx'

echo "==> Smoke test"
ssh "$DROPLET" "bash -s" <<EOF
set -euo pipefail
code=\$(curl -s -o /dev/null -w '%{http_code}' "http://localhost${BASE_PATH}")
echo "  GET ${BASE_PATH} -> \$code"
[[ "\$code" == "200" ]] || { echo "❌ Expected 200. Check /var/log/nginx/${SITE_NAME}.error.log" >&2; exit 1; }
EOF

echo "==> Done"

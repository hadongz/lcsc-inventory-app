#!/usr/bin/env bash
#
# Remove the components-inventory deployment from a droplet.
#
#   DROPLET=root@203.0.113.10 ./deploy/teardown.sh
#
# Shows what it found and asks before deleting anything. Set FORCE=1 to skip
# the prompt (required when running without a terminal, e.g. from CI).
#
# Leaves nginx itself installed — other sites may be using it. To remove nginx
# too, after this script:  apt-get purge -y nginx nginx-common && apt-get autoremove -y

set -euo pipefail

DROPLET="${DROPLET:?Set DROPLET, e.g. DROPLET=root@203.0.113.10}"
REMOTE_ROOT="${REMOTE_ROOT:-/var/www/components-inventory}"
SITE_NAME="${SITE_NAME:-components-inventory}"

# Guard against a mistyped override turning this into rm -rf /
case "$REMOTE_ROOT" in
  "" | "/" | "/var" | "/var/www")
    echo "❌ Refusing to delete REMOTE_ROOT=$REMOTE_ROOT" >&2
    exit 1
    ;;
esac

# Fail before touching the droplet if we could never get confirmation.
if [[ "${FORCE:-0}" != "1" && ! -t 0 ]]; then
  echo "❌ Not a terminal — re-run with FORCE=1 to confirm non-interactively." >&2
  exit 1
fi

echo "==> Looking for the deployment on $DROPLET"
ssh "$DROPLET" "bash -s" <<EOF
  echo "--- app files"
  du -sh "$REMOTE_ROOT" 2>/dev/null || echo "    (none)"
  echo "--- nginx site"
  ls -l /etc/nginx/sites-enabled/$SITE_NAME /etc/nginx/sites-available/$SITE_NAME 2>/dev/null || echo "    (none)"
  echo "--- logs"
  ls -l /var/log/nginx/$SITE_NAME.*.log* 2>/dev/null || echo "    (none)"
EOF

if [[ "${FORCE:-0}" != "1" ]]; then
  read -r -p "Remove all of the above from $DROPLET? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

echo "==> Removing"
ssh "$DROPLET" "bash -s" <<EOF
set -euo pipefail
rm -rf "$REMOTE_ROOT"
rm -f /etc/nginx/sites-enabled/$SITE_NAME
rm -f /etc/nginx/sites-available/$SITE_NAME
rm -f /var/log/nginx/$SITE_NAME.*.log*
nginx -t && systemctl reload nginx
EOF

echo "==> Verifying"
ssh "$DROPLET" "bash -s" <<EOF
  test -e "$REMOTE_ROOT" && echo "⚠️  $REMOTE_ROOT still exists" || echo "✓ app files gone"
  test -e /etc/nginx/sites-available/$SITE_NAME && echo "⚠️  site config still exists" || echo "✓ nginx site gone"
  systemctl is-active --quiet nginx && echo "✓ nginx still running (other sites unaffected)"
EOF

echo "==> Done"

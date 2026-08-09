#!/bin/sh
# Generate HTTP Basic Auth credentials for the web frontend at CONTAINER
# STARTUP (not build time). Lives in /docker-entrypoint.d/ so the stock
# nginx:alpine entrypoint runs it automatically before launching nginx.
#
# Controlled entirely by runtime env vars so the password can be rotated
# without rebuilding the image and never ends up baked into `docker history`:
#
#   WEB_PASSWORD  — if set & non-empty, Basic Auth is ENABLED.
#   WEB_USERNAME  — login name (default: admin).
#
# When WEB_PASSWORD is empty/unset, auth stays OFF (open access) so local
# dev keeps working exactly as before.
set -eu

AUTH_INC="/etc/nginx/conf.d/auth.inc"
HTPASSWD="/etc/nginx/.htpasswd"
USERNAME="${WEB_USERNAME:-admin}"

if [ -n "${WEB_PASSWORD:-}" ]; then
  # -b: password on cmd line, -c: create file, -B: bcrypt hashing.
  htpasswd -bcB "$HTPASSWD" "$USERNAME" "$WEB_PASSWORD" >/dev/null 2>&1
  # nginx worker processes run as the unprivileged `nginx` user, so the
  # file must be world-readable (it holds only a bcrypt hash, not the
  # plaintext password). 640 would give "Permission denied" 500s.
  chmod 644 "$HTPASSWD"
  cat > "$AUTH_INC" <<EOF
auth_basic           "Baize AI Agent — login required";
auth_basic_user_file $HTPASSWD;
EOF
  echo "[web-auth] Basic Auth ENABLED for user '$USERNAME'."
else
  # Empty include => no auth directives => open access.
  : > "$AUTH_INC"
  echo "[web-auth] WEB_PASSWORD not set — Basic Auth DISABLED (open access)."
fi

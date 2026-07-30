#!/bin/sh
# Regenerate the SPA's runtime config (app-config.js) at container startup
# from env vars. This lets ONE web image serve every deploy mode without a
# rebuild: the bundle reads window.__APP_CONFIG__ to decide behavior.
#
#   AUTH_ENABLED=true → SPA runs the SSO login flow and sends bearer tokens.
#   (unset / anything else) → auth off (admin/password & local modes).
#
#   API_BASE=https://agent.example.com → SPA sends all API calls to that
#   backend origin (use when the frontend is deployed SEPARATELY from the
#   agent). Unset / empty → same-origin (the default; nginx reverse-proxies).
#
#   AUTH_BASE=https://auth.example.com → SPA redirects the SSO login flow
#   (/sso/authorize, /sso/logout) to that auth-service origin directly.
#   Unset / empty → same-origin (nginx proxies /sso/*). Only relevant when
#   AUTH_ENABLED=true AND the frontend is deployed separately.
#
#   REMOTE_ENABLED=false → hide the header "Remote" environment picker
#   (SSO/admin tenant deploys). Unset / true → show (local / Electron).
set -eu

CONFIG_FILE="/usr/share/nginx/html/app-config.js"

if [ "$(printf '%s' "${AUTH_ENABLED:-}" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
  AUTH=true
else
  AUTH=false
fi

# Default ON when unset (local/dev). Explicit false/0/no disables.
_REMOTE_RAW="$(printf '%s' "${REMOTE_ENABLED:-true}" | tr '[:upper:]' '[:lower:]')"
case "$_REMOTE_RAW" in
  false|0|no|off) REMOTE=false ;;
  *) REMOTE=true ;;
esac

API_BASE_VALUE="${API_BASE:-}"
AUTH_BASE_VALUE="${AUTH_BASE:-}"

cat > "$CONFIG_FILE" <<EOF
window.__APP_CONFIG__ = { authEnabled: $AUTH, remoteEnabled: $REMOTE, apiBase: "$API_BASE_VALUE", authBase: "$AUTH_BASE_VALUE" };
EOF

echo "[web-config] app-config.js written (authEnabled=$AUTH, remoteEnabled=$REMOTE, apiBase='$API_BASE_VALUE', authBase='$AUTH_BASE_VALUE')."

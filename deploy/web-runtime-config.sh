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
set -eu

CONFIG_FILE="/usr/share/nginx/html/app-config.js"

if [ "$(printf '%s' "${AUTH_ENABLED:-}" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
  AUTH=true
else
  AUTH=false
fi

API_BASE_VALUE="${API_BASE:-}"
AUTH_BASE_VALUE="${AUTH_BASE:-}"

cat > "$CONFIG_FILE" <<EOF
window.__APP_CONFIG__ = { authEnabled: $AUTH, apiBase: "$API_BASE_VALUE", authBase: "$AUTH_BASE_VALUE" };
EOF

echo "[web-config] app-config.js written (authEnabled=$AUTH, apiBase='$API_BASE_VALUE', authBase='$AUTH_BASE_VALUE')."

#!/bin/sh
# Regenerate the SPA's runtime config (app-config.js) at container startup
# from the AUTH_ENABLED env var. This lets ONE web image serve every deploy
# mode without a rebuild: the bundle reads window.__APP_CONFIG__.authEnabled
# to decide whether to run the SSO login flow.
#
#   AUTH_ENABLED=true  → SPA redirects to /sso/authorize and sends bearer tokens
#   (unset / anything else) → auth off (password & local modes)
set -eu

CONFIG_FILE="/usr/share/nginx/html/app-config.js"

if [ "$(printf '%s' "${AUTH_ENABLED:-}" | tr '[:upper:]' '[:lower:]')" = "true" ]; then
  AUTH=true
else
  AUTH=false
fi

cat > "$CONFIG_FILE" <<EOF
window.__APP_CONFIG__ = { authEnabled: $AUTH };
EOF

echo "[web-config] app-config.js written (authEnabled=$AUTH)."

#!/bin/sh
# Generate the nginx reverse-proxy block for an EXTERNAL auth-service at
# container startup, from the AUTH_SERVICE_URL env var. This keeps the web
# image generic — the auth-service location is not baked in.
#
#   AUTH_SERVICE_URL set   → /sso/* and /api/auth/* proxy to that URL
#   AUTH_SERVICE_URL unset → empty include (password/local modes; the paths
#                            fall through to the SPA, nginx still boots)
#
# Example: AUTH_SERVICE_URL=http://10.150.115.69:52320
set -eu

INC="/etc/nginx/conf.d/auth-proxy.inc"

if [ -n "${AUTH_SERVICE_URL:-}" ]; then
  # Strip stray CR + any trailing slash. A trailing slash (URI part) in
  # proxy_pass inside a regex location makes nginx refuse to start, so this
  # normalization is required, not cosmetic.
  TARGET=$(printf '%s' "$AUTH_SERVICE_URL" | tr -d '\r' | sed 's:/*$::')
  # Unquoted heredoc: ${TARGET} is interpolated; nginx's own $vars are
  # escaped as \$ so they land in the file literally.
  cat > "$INC" <<EOF
location ~ ^/(sso|api/auth)(/|\$) {
    proxy_pass ${TARGET};
    proxy_http_version 1.1;
    proxy_set_header Host              \$host;
    proxy_set_header X-Real-IP         \$remote_addr;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection        "";
    proxy_read_timeout 60s;
}
EOF
  echo "[web-auth-proxy] /sso + /api/auth → ${TARGET}"
else
  : > "$INC"
  echo "[web-auth-proxy] AUTH_SERVICE_URL unset — SSO proxy disabled."
fi

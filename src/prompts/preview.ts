import { isPreviewEnabled, previewPathPrefix } from '../core/preview.js'
import {
  BASH_TOOL_NAME,
  PUBLISH_PREVIEW_TOOL_NAME,
} from '../constants/tool_names.js'

/** Cloud-only guidance for exposing dev servers via the preview proxy. */
export function previewSection(): string {
  if (!isPreviewEnabled()) return ''

  const prefix = previewPathPrefix()

  return `
# Web preview
- Remote container: user cannot open localhost - bind dev servers to 0.0.0.0, then call ${PUBLISH_PREVIEW_TOOL_NAME} after ${BASH_TOOL_NAME} (\`run_in_background: true\`).
- Share only the URL from ${PUBLISH_PREVIEW_TOOL_NAME}; avoid localhost in code and in replies.
- CRITICAL - base path: The preview proxy routes via ${prefix}/<port>/. Apps MUST be configured to use this as their base path so assets and routes resolve correctly:
  - Vite: set \`base: "${prefix}/<port>/"\` in vite.config (or pass \`--base ${prefix}/<port>/\` to the CLI).
  - Create React App: set \`PUBLIC_URL=${prefix}/<port>\` env var before build/start.
  - Next.js: set \`basePath: "${prefix}/<port>"\` in next.config.
  - Plain HTML: use relative paths for assets (e.g. \`./main.js\` not \`/main.js\`).
  - Backend API calls from the frontend should use relative URLs or respect the base path.
- For a separate backend API on another port, publish it separately and configure the frontend to call that preview URL directly (avoid CORS by using the same origin).
- Static games / single-page apps: inline all JS/CSS into one HTML file when possible. Serve with \`python -m http.server <port> --bind 0.0.0.0\`. Use ONLY relative paths (\`./\`) for any external assets (images, sounds). Never use absolute paths starting with \`/\`.`
}

import { isPreviewEnabled } from "../core/preview.js";
import { BASH_TOOL_NAME, PUBLISH_PREVIEW_TOOL_NAME } from "../tools/tool-names.js";

/** Cloud-only guidance for exposing dev servers via the preview proxy. */
export function previewSection(): string {
  if (!isPreviewEnabled()) return "";

  return `
# Web preview
 - Remote container: user cannot open localhost — bind dev servers to 0.0.0.0, then call ${PUBLISH_PREVIEW_TOOL_NAME} after ${BASH_TOOL_NAME} (background: true).
 - Share only the URL from ${PUBLISH_PREVIEW_TOOL_NAME}; avoid localhost in code and in replies.`;
}

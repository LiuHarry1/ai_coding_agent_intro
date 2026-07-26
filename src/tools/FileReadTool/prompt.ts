import {
  MAX_OUTPUT_SIZE_BYTES,
  PDF_MAX_PAGES_PER_READ,
} from '../../constants/api_limits.js'
import { READ_FILE_TOOL_NAME } from '../../constants/tool_names.js'

export { READ_FILE_TOOL_NAME }

export function buildReadToolDescription(): string {
  return (
    `Read a file from the workspace. Returns text with line numbers for code files; ` +
    `supports images (png/jpeg/gif/webp), PDFs (use pages for large files), and Jupyter notebooks (.ipynb). ` +
    `Text files over ${Math.round(MAX_OUTPUT_SIZE_BYTES / 1024)} KB are rejected — use grep or offset/limit first. ` +
    `PDF: use pages parameter (e.g. "1-5", max ${PDF_MAX_PAGES_PER_READ} pages per request).`
  )
}

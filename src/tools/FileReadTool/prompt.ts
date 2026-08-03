import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_LINES_TO_READ,
  MAX_OUTPUT_SIZE_BYTES,
  PDF_MAX_PAGES_PER_READ,
} from './limits.js'
import { FILE_READ_TOOL_NAME } from '../../constants/tool_names.js'

export { FILE_READ_TOOL_NAME }

export function buildReadToolDescription(): string {
  return (
    `Read a file from the workspace. Returns text with line numbers for code files; ` +
    `supports images (png/jpeg/gif/webp), PDFs (use pages for large files), and Jupyter notebooks (.ipynb). ` +
    `Whole-file reads are rejected when the file exceeds ${Math.round(MAX_OUTPUT_SIZE_BYTES / 1024)} KB, ` +
    `${MAX_LINES_TO_READ} lines, or ~${DEFAULT_MAX_OUTPUT_TOKENS} tokens — use offset/limit or grep first. ` +
    `PDF: use pages parameter (e.g. "1-5", max ${PDF_MAX_PAGES_PER_READ} pages per request).`
  )
}

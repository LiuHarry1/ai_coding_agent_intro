/**
 * UI/session projection for Read tool output.
 *
 * Model still receives full text/images via mapToolResultToToolResultBlockParam.
 * Wire `tool_use_result` must stay tiny — embedding PDF/image base64 (100KB–1MB+)
 * in SSE + session JSONL freezes the SPA on hydrate.
 */

import type { ReadOutput } from './types.js'

const PDF_PAGES_WIRE_MAX_CHARS = 500

/** Strip file bodies / base64 from Read output before UI or session persist. */
export function projectReadWireDetails(output: unknown): ReadOutput | unknown {
  if (!output || typeof output !== 'object') return output
  const out = output as ReadOutput
  switch (out.type) {
    case 'text':
      return {
        type: 'text',
        file: {
          filePath: out.file.filePath,
          // Header-only card; IDE opens the path. Keep a one-char stub so
          // empty-vs-missing range labels still work.
          content: out.file.content.length > 0 ? ' ' : '',
          numLines: out.file.numLines,
          startLine: out.file.startLine,
          totalLines: out.file.totalLines,
        },
      }
    case 'image':
      return {
        type: 'image',
        file: {
          filePath: out.file.filePath,
          base64: '',
          mediaType: out.file.mediaType,
          originalSize: out.file.originalSize,
        },
      }
    case 'pdf':
      return {
        type: 'pdf',
        file: {
          filePath: out.file.filePath,
          base64: '',
          originalSize: out.file.originalSize,
          pageCount: out.file.pageCount,
        },
      }
    case 'parts':
      return {
        type: 'parts',
        file: {
          filePath: out.file.filePath,
          originalSize: out.file.originalSize,
          count: out.file.count,
          // Keep path for debugging; do not list image bytes on the wire.
          outputDir: out.file.outputDir,
        },
      }
    case 'pdf_pages': {
      const text = out.file.text ?? ''
      return {
        type: 'pdf_pages',
        file: {
          filePath: out.file.filePath,
          pages: out.file.pages,
          text:
            text.length > PDF_PAGES_WIRE_MAX_CHARS
              ? `${text.slice(0, PDF_PAGES_WIRE_MAX_CHARS)}…`
              : text,
          pageCount: out.file.pageCount,
        },
      }
    }
    case 'notebook':
      return {
        type: 'notebook',
        file: {
          filePath: out.file.filePath,
          cells: [],
        },
      }
    case 'file_unchanged':
      return out
    default:
      return output
  }
}

/**
 * All bridge diagnostics go to stderr. stdout is reserved for LSP frames.
 * @param {string} message
 * @param {'info' | 'warn' | 'error'} [level]
 */
export function log(message, level = 'info') {
  const line = `[stpl-lsp-bridge] ${message}`
  console.error(line)
  void level
}

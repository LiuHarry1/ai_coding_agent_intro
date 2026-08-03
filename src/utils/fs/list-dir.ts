/**
 * Directory listing helper for @-mention attachments (not Read IO).
 */
import * as fs from 'fs'
import { MAX_DIR_ENTRIES } from '../../constants/api_limits.js'

export function listDirectoryEntries(
  absPath: string,
  displayPath: string,
): string {
  if (!fs.existsSync(absPath)) {
    throw new Error(`directory not found: ${displayPath}`)
  }
  const stat = fs.statSync(absPath)
  if (!stat.isDirectory()) {
    throw new Error(`${displayPath} is not a directory`)
  }
  const entries = fs.readdirSync(absPath)
  const truncated = entries.length > MAX_DIR_ENTRIES
  const names = entries.slice(0, MAX_DIR_ENTRIES)
  if (truncated) {
    names.push(`… and ${entries.length - MAX_DIR_ENTRIES} more entries`)
  }
  return names.join('\n')
}

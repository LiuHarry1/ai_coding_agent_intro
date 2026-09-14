/**
 * Shape summary for attached CSV/TSV files.
 *
 * A spreadsheet export is usually far too long to inline, and the first 2000
 * lines rarely answer the question anyway. Giving the model the column list,
 * inferred types, row count and on-disk path lets it decide between reading a
 * slice and running pandas over the whole thing.
 */

import * as fs from 'fs'

const SAMPLE_BYTES = 128 * 1024
const SAMPLE_ROWS = 50

export type TabularColumn = {
  name: string
  type: 'integer' | 'number' | 'boolean' | 'date' | 'empty' | 'string'
  sample: string
}

export type TabularSummary = {
  delimiter: ',' | '\t' | ';' | '|'
  columns: TabularColumn[]
  /** Data rows excluding the header. */
  rowCount: number
  sampledRows: number
}

/** Split one delimited line, honouring RFC 4180 double-quote escaping. */
export function splitDelimitedLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      out.push(field)
      field = ''
    } else {
      field += ch
    }
  }
  out.push(field)
  return out
}

function detectDelimiter(headerLine: string): TabularSummary['delimiter'] {
  const candidates: TabularSummary['delimiter'][] = [',', '\t', ';', '|']
  let best: TabularSummary['delimiter'] = ','
  let bestCount = 0
  for (const d of candidates) {
    const count = splitDelimitedLine(headerLine, d).length
    if (count > bestCount) {
      best = d
      bestCount = count
    }
  }
  return best
}

const INTEGER_RE = /^-?\d{1,15}$/
const NUMBER_RE = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/
const BOOLEAN_RE = /^(true|false|yes|no|y|n)$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?Z?$/

function inferType(values: string[]): TabularColumn['type'] {
  const present = values.filter(v => v.trim() !== '')
  if (present.length === 0) return 'empty'
  if (present.every(v => INTEGER_RE.test(v.trim()))) return 'integer'
  if (present.every(v => NUMBER_RE.test(v.trim()))) return 'number'
  if (present.every(v => BOOLEAN_RE.test(v.trim()))) return 'boolean'
  if (present.every(v => DATE_RE.test(v.trim()))) return 'date'
  return 'string'
}

/** Count newlines without loading the whole file. */
function countLines(absPath: string): number {
  const fd = fs.openSync(absPath, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    let lines = 0
    let read = 0
    let lastByte = -1
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < read; i++) {
        if (buf[i] === 0x0a) lines++
      }
      lastByte = buf[read - 1]!
    }
    // A trailing line without a newline still counts; an empty file has none.
    if (lastByte !== -1 && lastByte !== 0x0a) lines++
    return lines
  } finally {
    fs.closeSync(fd)
  }
}

export function summarizeDelimitedFile(absPath: string): TabularSummary | null {
  let head: string
  let readWasTruncated: boolean
  try {
    const fd = fs.openSync(absPath, 'r')
    try {
      const fileSize = fs.fstatSync(fd).size
      const size = Math.min(fileSize, SAMPLE_BYTES)
      readWasTruncated = fileSize > size
      const buf = Buffer.allocUnsafe(size)
      fs.readSync(fd, buf, 0, size, 0)
      head = buf.toString('utf-8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }

  const lines = head.split(/\r?\n/).filter(l => l.length > 0)
  if (lines.length === 0) return null

  const delimiter = detectDelimiter(lines[0]!)
  const header = splitDelimitedLine(lines[0]!, delimiter)
  if (header.length < 2) return null

  // A 128 KB cut lands mid-row, so the final sampled line is only suspect
  // when the read was truncated *and* that line is the one we stopped at.
  // Dropping it unconditionally loses the only data row of a short file.
  const body = lines.slice(1, SAMPLE_ROWS + 1)
  const endsMidRow = readWasTruncated && lines.length <= SAMPLE_ROWS + 1
  const rows = (endsMidRow ? body.slice(0, -1) : body)
    .map(l => splitDelimitedLine(l, delimiter))
    .filter(r => r.length === header.length)

  const columns = header.map((name, i) => {
    const values = rows.map(r => r[i] ?? '')
    const sample = values.find(v => v.trim() !== '') ?? ''
    return {
      name: name.trim() || `column_${i + 1}`,
      type: inferType(values),
      sample: sample.length > 40 ? `${sample.slice(0, 40)}…` : sample,
    }
  })

  let totalLines: number
  try {
    totalLines = countLines(absPath)
  } catch {
    totalLines = lines.length
  }

  return {
    delimiter,
    columns,
    rowCount: Math.max(0, totalLines - 1),
    sampledRows: rows.length,
  }
}

const DELIMITER_LABEL: Record<TabularSummary['delimiter'], string> = {
  ',': 'comma',
  '\t': 'tab',
  ';': 'semicolon',
  '|': 'pipe',
}

export function formatTabularSummary(
  summary: TabularSummary,
  displayName: string,
  absPath: string,
): string {
  const cols = summary.columns
    .map(c => `  - ${c.name} (${c.type})${c.sample ? ` e.g. ${c.sample}` : ''}`)
    .join('\n')
  return (
    `Tabular attachment ${displayName}: ${summary.rowCount} data rows × ` +
    `${summary.columns.length} columns, ${DELIMITER_LABEL[summary.delimiter]}-separated.\n` +
    `Columns:\n${cols}\n` +
    `Full file on disk: ${absPath}\n` +
    `Only a prefix is shown above. For aggregates, filtering, or anything ` +
    `touching rows beyond the preview, process the file on disk instead of asking to see more of it.`
  )
}

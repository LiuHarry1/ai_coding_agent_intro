/**
 * Turning Playwright's raw aria snapshot into what the model actually reads.
 *
 * Three passes on the YAML, in the order `prioritizeAriaSnapshot` applies them:
 *
 * 1. `dropRedundantWrapperNames` — a card whose accessible name is just its
 *    subtree read out pays for the same text twice.
 * 2. `groupBadgeLabels` — a "1" badge beside a label is one widget to a human
 *    and two ref-bearing nodes to the model; the ref belongs on the parent.
 * 3. the budget itself — see below.
 *
 * Deliberately text-in, text-out with no imports: none of this needs a browser,
 * so it is unit-tested directly and stays out of `playwright/`.
 *
 * On the budget: the AI snapshot keeps every interactable in document order, and
 * chat docks, cookie banners and `role=dialog` panels are usually last. A
 * head-only clip — what OpenClaw's AI snapshot path does — drops them on any long
 * homepage, which is exactly how a "messages" task loses the inbox it just
 * opened. So the budget is spent by priority rather than by position: dialogs and
 * the widgets around them first, then as much of the page start as still fits.
 *
 * Two budgets follow that same policy. Characters bound what the model pays for;
 * nodes bound how many refs it has to choose between, which is the number that
 * decides whether it can find the control it wants.
 */

const DIALOG_ITEM = /^(\s*)- (dialog|alertdialog)\b/

const OMITTED =
  '# … middle omitted; open dialogs and end-of-tree widgets were kept. Pass selector to snapshot a subtree.'

interface Range {
  start: number
  end: number
}

/** Ref-bearing nodes: the units the model actually picks between. */
export function countRefs(text: string): number {
  return (text.match(/\[ref=/g) ?? []).length
}

/**
 * Container roles whose accessible name is just their subtree read out. A card
 * like `listitem "Staff Engineer Remote $200k <the whole preview>"` pays for the
 * same text twice, once as the wrapper's name and again in the children — and on
 * a list of them that is most of the budget.
 *
 * Playwright's AI mode drops names already covered by the children it emits, but
 * not for these, so we finish the job on the YAML.
 */
const WRAPPER_NAME_ROLES = new Set([
  'listitem',
  'generic',
  'group',
  'row',
  'cell',
  'gridcell',
  'article',
  'region',
  'section',
  'list',
  'table',
  'rowgroup',
  'figure',
  'banner',
  'main',
  'navigation',
  'complementary',
  'contentinfo',
  'form',
])

const NAMED_NODE = /^(\s*- )([a-z]+)(?: "((?:[^"\\]|\\.)*)")(.*)$/

/** Only worth dropping when it is long enough to matter. */
const REDUNDANT_NAME_MIN = 40

function comparable(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
}

/**
 * The words a node contributes, without the markup. Comparing whole YAML lines
 * fails because `[ref=e42]` and `/url:` sit between the very words we are trying
 * to match against the wrapper's name.
 */
function nodeText(line: string): string {
  const body = line.trim().replace(/^-\s*/, '')
  // Property lines (`/url:`, `/placeholder:`) are not part of the name.
  if (body.startsWith('/')) return ''
  const quoted = /"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? ''
  const inline = /:\s*(.+)$/.exec(body)?.[1] ?? ''
  return `${quoted} ${inline}`
}

export function dropRedundantWrapperNames(yaml: string): string {
  const lines = yaml.split('\n')
  const out = lines.slice()
  for (let i = 0; i < lines.length; i++) {
    const m = NAMED_NODE.exec(lines[i])
    if (!m) continue
    const [, head, role, name, rest] = m
    if (!WRAPPER_NAME_ROLES.has(role) || name.length < REDUNDANT_NAME_MIN) {
      continue
    }
    const indent = /^\s*/.exec(lines[i])![0].length
    let subtree = ''
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*/.exec(lines[j])![0].length <= indent) break
      subtree += ` ${nodeText(lines[j])}`
    }
    // Keep a real aria-label: only the name the children already spell out goes.
    if (subtree && comparable(subtree).includes(comparable(name))) {
      out[i] = `${head}${role}${rest}`
    }
  }
  return out.join('\n')
}

export function prioritizeAriaSnapshot(
  raw: string,
  opts: { maxChars: number; maxNodes?: number },
): { text: string; truncated: boolean } {
  const { maxChars } = opts
  const maxNodes = opts.maxNodes ?? Number.POSITIVE_INFINITY
  const grouped = groupBadgeLabels(dropRedundantWrapperNames(raw))
  if (grouped.length <= maxChars && countRefs(grouped) <= maxNodes) {
    return { text: grouped, truncated: false }
  }

  const lines = grouped.split('\n')
  const dialogs = findDialogRanges(lines)
  const keep: Range[] = []

  if (dialogs.length) {
    const first = dialogs[0].start
    keep.push({ start: Math.max(0, first - 24), end: first })
    keep.push(...dialogs)
    const last = dialogs[dialogs.length - 1].end
    keep.push({ start: last, end: Math.min(lines.length, last + 8) })
  } else {
    // Footer iframes (Playwright `f3eN`) sit after the chat dock in document
    // order and would steal the tail budget. Keep the last lines of the same
    // frame as the root instead.
    keep.push(tailOfPrimaryFrame(lines, 48))
  }

  const reserved = joinRanges(lines, mergeRanges(keep))
  // What survives when even the reserved block does not fit. The lines leading
  // up to a dialog are context; the dialog is the thing the model opened.
  const core = joinRanges(lines, mergeRanges(dialogs.length ? dialogs : keep))
  const overhead = OMITTED.length + 2
  const headRoom = Math.max(0, maxChars - reserved.length - overhead)
  const headNodes = Math.max(0, maxNodes - countRefs(reserved))
  const headEnd = headLineCount(
    lines,
    keep[0]?.start ?? lines.length,
    headRoom,
    headNodes,
  )
  const ranges = mergeRanges([{ start: 0, end: headEnd }, ...keep])

  const chunks: string[] = []
  let cursor = 0
  for (const range of ranges) {
    if (range.start > cursor) chunks.push(OMITTED)
    chunks.push(lines.slice(range.start, range.end).join('\n'))
    cursor = range.end
  }
  if (cursor < lines.length) chunks.push(OMITTED)

  let text = chunks.filter(Boolean).join('\n')
  if (text.length > maxChars || countRefs(text) > maxNodes) {
    // Budget is smaller than the reserved block: keep its start (dialog title +
    // first rows), not the page head.
    const prefix = headEnd > 0 ? `${lines.slice(0, headEnd).join('\n')}\n${OMITTED}\n` : ''
    text =
      prefix +
      clipToBudget(
        core,
        Math.max(0, maxChars - prefix.length),
        Math.max(0, maxNodes - countRefs(prefix)),
      )
  }
  return { text, truncated: true }
}

function frameKey(line: string): string | null {
  const m = /\[ref=(f\d+)?e\d+\]/.exec(line)
  if (!m) return null
  return m[1] ?? ''
}

function tailOfPrimaryFrame(lines: string[], n: number): Range {
  if (lines.length === 0) return { start: 0, end: 0 }
  let primary: string | null = null
  for (const line of lines) {
    const key = frameKey(line)
    if (key !== null) {
      primary = key
      break
    }
  }
  if (primary === null) {
    return { start: Math.max(0, lines.length - n), end: lines.length }
  }
  const idx: number[] = []
  for (let i = lines.length - 1; i >= 0 && idx.length < n; i--) {
    const key = frameKey(lines[i])
    if (key !== null && key !== primary) continue
    if (/^\s*- iframe\b/.test(lines[i])) continue
    idx.push(i)
  }
  if (!idx.length) {
    return { start: Math.max(0, lines.length - n), end: lines.length }
  }
  return { start: Math.min(...idx), end: Math.max(...idx) + 1 }
}

function findDialogRanges(lines: string[]): Range[] {
  const ranges: Range[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!DIALOG_ITEM.test(lines[i])) continue
    const end = subtreeEnd(lines, i)
    ranges.push({ start: i, end })
    i = end - 1
  }
  return ranges
}

function subtreeEnd(lines: string[], start: number): number {
  const indent = leadingSpaces(lines[start])
  let i = start + 1
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i += 1
      continue
    }
    if (/^\s*- /.test(line) && leadingSpaces(line) <= indent) break
    i += 1
  }
  return i
}

function leadingSpaces(line: string): number {
  const match = /^ */.exec(line)
  return match ? match[0].length : 0
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges
    .filter(r => r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Range[] = []
  for (const range of sorted) {
    const last = out[out.length - 1]
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else out.push({ ...range })
  }
  return out
}

function joinRanges(lines: string[], ranges: Range[]): string {
  return ranges.map(r => lines.slice(r.start, r.end).join('\n')).join('\n')
}

function headLineCount(
  lines: string[],
  stopBefore: number,
  charBudget: number,
  nodeBudget: number,
): number {
  if (charBudget <= 0 || stopBefore <= 0) return 0
  let chars = 0
  let nodes = 0
  let i = 0
  while (i < stopBefore) {
    const extra = lines[i].length + (i === 0 ? 0 : 1)
    const refs = countRefs(lines[i])
    if (chars + extra > charBudget) break
    if (nodes + refs > nodeBudget) break
    chars += extra
    nodes += refs
    i += 1
  }
  return i
}

/** Whole lines from the start, until either budget runs out. */
function clipToBudget(
  text: string,
  charBudget: number,
  nodeBudget: number,
): string {
  const lines = text.split('\n')
  const out: string[] = []
  let chars = 0
  let nodes = 0
  for (const line of lines) {
    const extra = line.length + (out.length === 0 ? 0 : 1)
    const refs = countRefs(line)
    if (chars + extra > charBudget) break
    if (nodes + refs > nodeBudget) break
    chars += extra
    nodes += refs
    out.push(line)
  }
  return out.join('\n')
}

const BADGE_CHILD =
  /^(\s*)- (emphasis|generic|text)(?: \[[^\]]+\])* \[ref=([^\]]+)\](?: \[[^\]]+\])*: ["']?(\d+)["']?\s*$/
const LABEL_CHILD =
  /^(\s*)- (generic|text)(?: ((?:\[[^\]]+\] ?)*))?: (.+)\s*$/

/**
 * Playwright stamps a ref on a numeric badge and leaves the visible label as a
 * sibling. The CDP distiller already groups those; do the same to the YAML so
 * the model clicks "有新消息" instead of `em "1"`.
 */
export function groupBadgeLabels(raw: string): string {
  const lines = raw.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const parent = lines[i]
    const parentIndent = leadingSpaces(parent)
    if (!/^\s*- generic\b/.test(parent)) {
      out.push(parent)
      i += 1
      continue
    }

    const childStart = i + 1
    if (
      childStart >= lines.length ||
      leadingSpaces(lines[childStart]) <= parentIndent ||
      !/^\s*- /.test(lines[childStart])
    ) {
      out.push(parent)
      i += 1
      continue
    }

    const childIndent = leadingSpaces(lines[childStart])
    if (childIndent !== parentIndent + 2) {
      out.push(parent)
      i += 1
      continue
    }

    const childHeads: number[] = []
    let j = childStart
    while (j < lines.length) {
      const line = lines[j]
      if (line.trim() === '') {
        j += 1
        continue
      }
      const ind = leadingSpaces(line)
      if (ind < childIndent) break
      if (ind === childIndent && /^\s*- /.test(line)) childHeads.push(j)
      j += 1
    }
    const subtreeEnd = j

    let badgeIdx = -1
    let labelIdx = -1
    let combinedIdx = -1
    for (const idx of childHeads) {
      if (matchBadge(lines[idx])) {
        if (badgeIdx >= 0) {
          badgeIdx = -2
          break
        }
        badgeIdx = idx
      } else if (combinedIdx < 0 && matchCombinedText(lines[idx])) {
        combinedIdx = idx
      } else if (labelIdx < 0 && matchLabel(lines[idx])) {
        labelIdx = idx
      }
    }

    const badge = badgeIdx >= 0 ? matchBadge(lines[badgeIdx]) : null
    const label =
      labelIdx >= 0
        ? matchLabel(lines[labelIdx])
        : combinedIdx >= 0
          ? matchCombinedText(lines[combinedIdx])
          : null
    if (!label || (!badge && combinedIdx < 0)) {
      out.push(parent)
      i += 1
      continue
    }

    const parentRef =
      /\[ref=([^\]]+)\]/.exec(parent)?.[1] ?? badge?.ref ?? 'e0'
    out.push(promoteParent(parent, parentRef, label.name))

    const skip = new Set<number>()
    if (labelIdx >= 0) {
      const labelEnd = subtreeEndFrom(lines, labelIdx, subtreeEnd)
      for (let k = labelIdx; k < labelEnd; k++) skip.add(k)
    }

    for (let k = childStart; k < subtreeEnd; k++) {
      if (skip.has(k)) continue
      if (badge && k === badgeIdx) {
        out.push(`${badge.indent}- ${badge.role}: "${badge.digits}"`)
        const badgeEnd = subtreeEndFrom(lines, badgeIdx, subtreeEnd)
        for (let extra = k + 1; extra < badgeEnd; extra++) skip.add(extra)
        continue
      }
      if (k === combinedIdx) {
        const combined = matchCombinedText(lines[k])!
        out.push(`${combined.indent}- text: "${combined.badge}"`)
        continue
      }
      if (/^\s*- img\b/.test(lines[k]) && /\[cursor=pointer\]/.test(lines[k])) {
        out.push(
          lines[k]
            .replace(/ \[ref=[^\]]+\]/g, '')
            .replace(/ \[cursor=pointer\]/g, ''),
        )
        continue
      }
      out.push(lines[k])
    }
    i = subtreeEnd
  }
  return out.join('\n')
}

function promoteParent(parent: string, parentRef: string, name: string): string {
  const stripped = parent
    .replace(/\[cursor=pointer\]\s*/g, '')
    .replace(/\s*:?\s*$/, '')
  const named = /: \S/.test(parent) ? stripped : `${stripped}: ${name}`
  const withRef = /\[ref=/.test(named)
    ? named
    : named.replace(/^( *- generic)/, `$1 [ref=${parentRef}]`)
  return /\[cursor=pointer\]/.test(withRef)
    ? withRef
    : withRef.replace(/(\[ref=[^\]]+\])/, '$1 [cursor=pointer]')
}

function subtreeEndFrom(lines: string[], start: number, limit: number): number {
  const indent = leadingSpaces(lines[start])
  let i = start + 1
  while (i < limit) {
    const line = lines[i]
    if (line.trim() === '') {
      i += 1
      continue
    }
    if (/^\s*- /.test(line) && leadingSpaces(line) <= indent) break
    i += 1
  }
  return i
}

function matchBadge(
  line: string,
): { line: string; indent: string; role: string; ref: string; digits: string } | null {
  const m = BADGE_CHILD.exec(line)
  if (!m) return null
  return { line, indent: m[1], role: m[2], ref: m[3], digits: m[4] }
}

function matchLabel(
  line: string,
): { line: string; name: string } | null {
  const m = LABEL_CHILD.exec(line)
  if (!m) return null
  const name = m[4].replace(/^["']|["']$/g, '').trim()
  if (!name || /^\d+$/.test(name)) return null
  if (name.startsWith('/url:')) return null
  if (matchCombinedText(line)) return null
  return { line, name }
}

function matchCombinedText(
  line: string,
): { line: string; indent: string; badge: string; name: string } | null {
  const m = /^(\s*)- text: ["']?(\d+)\s+(.+?)["']?\s*$/.exec(line)
  if (!m) return null
  const name = m[3].trim()
  if (!name || /^\d+$/.test(name)) return null
  return { line, indent: m[1], badge: m[2], name }
}

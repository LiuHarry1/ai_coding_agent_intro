/**
 * Offline + API attachment regression suite for workspace test9.
 * Run: npx tsx examples/08-basic/scripts/test-attachment-suite.ts
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { extractAtMentionedFiles } from '../utils/attachments/extract-mentions.js'
import { processAtMentionedFiles } from '../utils/attachments/generate-file-attachment.js'
import {
  expandAttachmentMessagesForAPI,
  mergeAdjacentUserMessages,
  smooshSystemReminderSiblings,
} from '../utils/messages.js'
import { isAttachmentMessage } from '../core/types.js'
import type { Message } from '../core/types.js'
import type { ReadFileState } from '../utils/attachments/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const SESSION_DIR = path.join(REPO_ROOT, '.sessions')
const WORKSPACE = '/Users/harry/cursor_workspace/test9'
const SESSION_ID = '9f94986d-2d38-47ef-bfe7-f8826447af9c'

type Result = { name: string; ok: boolean; detail: string }

const results: Result[] = []

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}: ${detail}`)
}

function restoreMessagesFromJsonl(id: string): Message[] {
  const filePath = path.join(SESSION_DIR, `${id}.jsonl`)
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as Record<string, unknown>)
  const messages: Message[] = []
  for (const line of lines) {
    if (line.type === 'message') {
      const { type: _, timestamp: __, ...msg } = line
      messages.push(msg as Message)
    } else if (line.type === 'attachment') {
      const { timestamp: _, ...msg } = line
      messages.push(msg as Message)
    }
  }
  return messages
}

async function runOfflineTests(): Promise<void> {
  console.log('\n=== Offline tests ===\n')

  const cjk = extractAtMentionedFiles('给我修改一下@syntax_error.py')
  record(
    'mention CJK-before-@',
    cjk.includes('syntax_error.py'),
    JSON.stringify(cjk),
  )

  const spaced = extractAtMentionedFiles('修改 @syntax_error.py 内容')
  record(
    'mention space-before-@',
    spaced.includes('syntax_error.py'),
    JSON.stringify(spaced),
  )

  const start = extractAtMentionedFiles('@hello_world.py 读一下')
  record(
    'mention line-start @',
    start.includes('hello_world.py'),
    JSON.stringify(start),
  )

  const restored = restoreMessagesFromJsonl(SESSION_ID)
  const attachmentCount = restored.filter(isAttachmentMessage).length
  const types = restored.filter(isAttachmentMessage).map(m => m.attachment.type)
  record(
    'session reload from JSONL',
    attachmentCount >= 5 &&
      types.includes('skill_listing') &&
      types.includes('diagnostics') &&
      types.includes('file'),
    `${attachmentCount} attachments types=${[...new Set(types)].join(',')}`,
  )

  const readFileState: ReadFileState = new Map()
  const atFiles = await processAtMentionedFiles('看一下 @syntax_error.py', {
    cwd: WORKSPACE,
    readFileState,
  })
  record(
    '@syntax_error.py attachment',
    atFiles.length === 1 && atFiles[0]!.type === 'file',
    atFiles.map(a => a.type).join(',') || 'none',
  )

  const huge = await processAtMentionedFiles('@huge_file.txt', {
    cwd: WORKSPACE,
    readFileState: new Map(),
  })
  const hugeAtt = huge[0]
  const truncated =
    hugeAtt?.type === 'file' &&
    'truncated' in hugeAtt &&
    hugeAtt.truncated === true
  record(
    'huge file truncated attachment',
    truncated,
    hugeAtt
      ? `type=${hugeAtt.type} truncated=${'truncated' in hugeAtt ? hugeAtt.truncated : 'n/a'}`
      : 'no attachment',
  )

  if (hugeAtt && hugeAtt.type === 'file') {
    const expanded = expandAttachmentMessagesForAPI([
      {
        type: 'attachment',
        attachment: hugeAtt,
        uuid: 'test-huge',
        timestamp: new Date().toISOString(),
        isMeta: true,
      },
    ])
    const merged = mergeAdjacentUserMessages(expanded)
    const smooshed = smooshSystemReminderSiblings(merged)
    const userMsgs = smooshed.filter(
      m => !isAttachmentMessage(m) && m.role === 'user',
    )
    record(
      'huge file merge+smoosh',
      userMsgs.length >= 1,
      `user messages after prep: ${userMsgs.length}`,
    )
  } else {
    record('huge file merge+smoosh', false, 'skipped — no file attachment')
  }
}

async function chatOnce(
  sessionId: string,
  message: string,
): Promise<{ ok: boolean; detail: string; newLines: number }> {
  const before = fs.existsSync(path.join(SESSION_DIR, `${sessionId}.jsonl`))
    ? fs
        .readFileSync(path.join(SESSION_DIR, `${sessionId}.jsonl`), 'utf8')
        .split('\n').length
    : 0

  const res = await fetch('http://localhost:4567/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      message,
      workspace: WORKSPACE,
      session_id: sessionId,
      stream: true,
    }),
  })

  if (!res.ok) {
    return { ok: false, detail: `HTTP ${res.status}`, newLines: 0 }
  }

  const text = await res.text()
  const done = text.includes('event: done') || text.includes('"done"')
  const after = fs
    .readFileSync(path.join(SESSION_DIR, `${sessionId}.jsonl`), 'utf8')
    .split('\n').length
  return {
    ok: done && !text.includes('event: error'),
    detail: done
      ? `stream complete (+${after - before} jsonl lines)`
      : 'no done event',
    newLines: after - before,
  }
}

function tailJsonlTypes(sessionId: string, n = 8): string {
  const lines = fs
    .readFileSync(path.join(SESSION_DIR, `${sessionId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .slice(-n)
    .map(l => {
      const o = JSON.parse(l) as {
        type: string
        attachment?: { type: string }
        role?: string
      }
      if (o.type === 'attachment') return `attachment:${o.attachment?.type}`
      if (o.type === 'message') return `message:${o.role}`
      return o.type
    })
  return lines.join(' → ')
}

async function runApiTests(): Promise<void> {
  console.log('\n=== API tests (server + LLM) ===\n')

  try {
    const health = await fetch('http://localhost:4567/sessions')
    if (!health.ok) throw new Error(`HTTP ${health.status}`)
  } catch (e) {
    record('server reachable', false, String(e))
    return
  }
  record('server reachable', true, 'GET /sessions ok')

  // Session reload: clear in-memory cache by restarting — already restarted before this script
  const reloadRes = await fetch(
    `http://localhost:4567/sessions/${SESSION_ID}/messages`,
  )
  const reloadJson = (await reloadRes.json()) as { messages?: unknown[] }
  const jsonlLines = fs
    .readFileSync(path.join(SESSION_DIR, `${SESSION_ID}.jsonl`), 'utf8')
    .trim()
    .split('\n').length
  record(
    'API session reload (JSONL lines)',
    reloadRes.ok && jsonlLines >= 25,
    `jsonl_lines=${jsonlLines} ui_messages=${reloadJson.messages?.length ?? 0}`,
  )

  const r1 = await chatOnce(
    SESSION_ID,
    '给我修改一下@syntax_error.py 读一下内容',
  )
  const tail1 = tailJsonlTypes(SESSION_ID)
  const hasFileAtt = tail1.includes('attachment:file')
  record(
    'chat CJK @syntax_error.py → file attachment',
    r1.ok && hasFileAtt,
    `${r1.detail}; tail: ${tail1}`,
  )

  const r2 = await chatOnce(
    SESSION_ID,
    '在 warning_test.py 里加一行 unused = 42，不要修 lint',
  )
  const tail2 = tailJsonlTypes(SESSION_ID, 12)
  record(
    'chat Edit warning_test.py',
    r2.ok && tail2.includes('tool'),
    `${r2.detail}; tail: ${tail2}`,
  )

  const r3 = await chatOnce(SESSION_ID, '@huge_file.txt 只读前10行内容')
  const tail3 = tailJsonlTypes(SESSION_ID)
  const jsonl = fs.readFileSync(
    path.join(SESSION_DIR, `${SESSION_ID}.jsonl`),
    'utf8',
  )
  const hasHugeFileAtt =
    jsonl.includes('huge_file.txt') && jsonl.includes('"truncated":true')
  record(
    'chat @huge_file.txt truncated attachment',
    r3.ok && hasHugeFileAtt,
    `${r3.detail}; tail: ${tail3}; truncated_in_jsonl=${hasHugeFileAtt}`,
  )
}

async function main(): Promise<void> {
  console.log(`workspace=${WORKSPACE}`)
  console.log(`session=${SESSION_ID}`)
  await runOfflineTests()
  await runApiTests()

  const failed = results.filter(r => !r.ok)
  console.log(
    `\n=== Summary: ${results.length - failed.length}/${results.length} passed ===`,
  )
  if (failed.length) {
    console.log('Failed:')
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

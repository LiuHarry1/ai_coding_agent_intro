/**
 * Unit tests for auto-memory (paths, scan, inject, skip-if-wrote, throttle).
 * Run: npx tsx src/scripts/test-auto-memory.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { Message } from '../core/types.js'
import {
  buildAutoMemorySystemAppend,
  clearAllAutoMemoryState,
  ensureAutoMemDir,
  ensureIndexEntry,
  getAutoMemPath,
  getAutoMemoryState,
  hasMemoryWritesSince,
  rebuildIndex,
  resetAutoMemoryState,
  sanitizePath,
  scanMemoryFiles,
  shouldExtractAutoMemory,
  truncateEntrypointContent,
  verifyAndRepairIndex,
} from '../services/auto-memory/index.js'
import {
  ensureMessageUuid,
  getMessageUuid,
} from '../services/session-memory/messageUuid.js'
import {
  assertAccessible,
  createSandboxPolicy,
} from '../core/sandbox.js'
import {
  DEFAULTS,
  resolveAutoMemoryConfig,
  resolveSettings,
  resetSettingsCache,
} from '../core/settings-manager.js'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[FAIL] ${msg}`)
    process.exit(1)
  }
  console.log(`[PASS] ${msg}`)
}

function assistantWrite(filePath: string): Message {
  return ensureMessageUuid({
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: randomUUID(),
        toolName: 'Write',
        input: { file_path: filePath, content: 'x' },
      },
    ],
  })
}

// ── sanitizePath ─────────────────────────────────
{
  assert(sanitizePath('/foo/bar') === '-foo-bar', 'sanitize path slashes')
  assert(
    sanitizePath('a'.repeat(250)).length <= 220,
    'sanitize truncates long paths',
  )
}

// ── paths + scan + index ─────────────────────────
{
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mem-'))
  ensureAutoMemDir(mem)
  const topic = path.join(mem, 'prefer-concise.md')
  fs.writeFileSync(
    topic,
    [
      '---',
      'name: Prefer concise',
      'description: Short replies',
      'type: feedback',
      '---',
      '',
      'Be brief.',
      '',
    ].join('\n'),
    'utf-8',
  )
  const files = scanMemoryFiles(mem)
  assert(files.length === 1, 'scan finds topic file')
  assert(files[0]!.type === 'feedback', 'parses type frontmatter')

  rebuildIndex(mem)
  const entry = fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf-8')
  assert(entry.includes('prefer-concise.md'), 'rebuildIndex writes pointer')

  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '', 'utf-8')
  const v = verifyAndRepairIndex(mem)
  assert(v.repaired === 1, 'verifyAndRepairIndex repairs missing entry')
  assert(
    fs
      .readFileSync(path.join(mem, 'MEMORY.md'), 'utf-8')
      .includes('prefer-concise'),
    'repaired index has title',
  )

  ensureIndexEntry(mem, 'prefer-concise.md', 'Prefer concise')
  assert(
    ensureIndexEntry(mem, 'prefer-concise.md', 'Prefer concise') === false,
    'ensureIndexEntry is idempotent',
  )

  fs.rmSync(mem, { recursive: true, force: true })
}

// ── truncate ─────────────────────────────────────
{
  const lines = Array.from({ length: 250 }, (_, i) => `- item ${i}`)
  const { content, truncated } = truncateEntrypointContent(lines.join('\n'))
  assert(truncated, 'truncates long index')
  assert(content.includes('truncated'), 'adds truncation marker')
}

// ── inject empty vs non-empty ────────────────────
{
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mem-inj-'))
  process.env.AI_AGENT_MEMORY_PATH = mem
  ensureAutoMemDir(mem)

  const enabledCfg = resolveAutoMemoryConfig({
    ...DEFAULTS,
    autoMemoryEnabled: true,
  })
  const emptyAppend = buildAutoMemorySystemAppend({
    cwd: process.cwd(),
    config: enabledCfg,
  })
  assert(emptyAppend.includes('# auto memory'), 'enabled injects guide')
  assert(
    !emptyAppend.includes('## Auto memory index'),
    'empty MEMORY.md skips index section',
  )

  fs.writeFileSync(
    path.join(mem, 'MEMORY.md'),
    '- [Prefer concise](prefer-concise.md) — short\n',
    'utf-8',
  )
  const withIndex = buildAutoMemorySystemAppend({
    cwd: process.cwd(),
    config: enabledCfg,
  })
  assert(withIndex.includes('## Auto memory index'), 'non-empty injects index')
  assert(withIndex.includes('prefer-concise.md'), 'index content present')

  const disabled = buildAutoMemorySystemAppend({
    cwd: process.cwd(),
    config: resolveAutoMemoryConfig({
      ...DEFAULTS,
      autoMemoryEnabled: false,
    }),
  })
  assert(disabled === '', 'disabled injects nothing')

  delete process.env.AI_AGENT_MEMORY_PATH
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── hasMemoryWritesSince ─────────────────────────
{
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mem-hw-'))
  const cursor = ensureMessageUuid({ role: 'user', content: 'hi' })
  const wrote = assistantWrite(path.join(mem, 'x.md'))
  const cursorUuid = getMessageUuid(cursor)
  assert(
    !!cursorUuid && hasMemoryWritesSince([cursor, wrote], cursorUuid, mem),
    'detects memdir write after cursor',
  )
  assert(
    !!cursorUuid &&
      !hasMemoryWritesSince(
        [cursor, assistantWrite('/tmp/other.md')],
        cursorUuid,
        mem,
      ),
    'ignores writes outside memdir',
  )
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── throttle (default every 1 turn) ────────────────
{
  clearAllAutoMemoryState()
  const sid = `am-${randomUUID()}`
  const cfg = resolveAutoMemoryConfig(DEFAULTS)
  assert(cfg.extractEveryNTurns === 1, 'default extractEveryNTurns is 1')
  assert(shouldExtractAutoMemory(sid, cfg), 'fires on first eligible turn')
  assert(shouldExtractAutoMemory(sid, cfg, true), 'force always allowed')
  resetAutoMemoryState(sid)

  const throttled = { ...cfg, extractEveryNTurns: 3 }
  assert(!shouldExtractAutoMemory(sid, throttled), 'custom throttle turn 1')
  assert(!shouldExtractAutoMemory(sid, throttled), 'custom throttle turn 2')
  assert(shouldExtractAutoMemory(sid, throttled), 'custom throttle turn 3')
}

// ── sandbox carve-out ────────────────────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-am-'))
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-mem-'))
  const policy = createSandboxPolicy(root, {
    extraWriteRoots: [mem],
    extraReadRoots: [mem],
  })
  assertAccessible(path.join(mem, 'MEMORY.md'), policy, 'write')
  let refused = false
  try {
    assertAccessible(path.join(root, '..', 'nope.txt'), policy, 'write')
  } catch {
    refused = true
  }
  assert(refused, 'still refuses unrelated outside writes')
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── getAutoMemPath env override ──────────────────
{
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mem-env-'))
  process.env.AI_AGENT_MEMORY_PATH = mem
  assert(
    getAutoMemPath({ cwd: process.cwd() }) === path.resolve(mem),
    'AI_AGENT_MEMORY_PATH overrides default',
  )
  delete process.env.AI_AGENT_MEMORY_PATH
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── flat settings + project directory strip ───────
{
  assert(DEFAULTS.autoMemoryEnabled === true, 'default autoMemoryEnabled true')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-settings-'))
  const appDir = path.join(tmp, '.ai-agent')
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(
    path.join(appDir, 'settings.json'),
    JSON.stringify({
      autoMemoryEnabled: false,
      autoMemoryDirectory: path.join(os.homedir(), '.ssh'),
    }),
    'utf-8',
  )
  resetSettingsCache()
  const resolved = resolveSettings(tmp)
  assert(
    resolved.config.autoMemoryEnabled === false,
    'project can set autoMemoryEnabled',
  )
  assert(
    resolved.config.autoMemoryDirectory === undefined,
    'project autoMemoryDirectory is stripped',
  )
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\nAll auto-memory tests passed.')

/**
 * Offline tests for memory age, manifest, findRelevant, prefetch consume.
 * Run: npx tsx src/scripts/test-memory-prefetch.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  memoryAge,
  memoryAgeDays,
  memoryFreshnessText,
  memoryHeader,
  formatMemoryManifest,
  scanMemoryFiles,
  findRelevantMemories,
  readMemoriesForSurfacing,
  collectSurfacedMemories,
  startRelevantMemoryPrefetch,
  consumeMemoryPrefetchIfReady,
  ensureAutoMemDir,
  MAX_MEMORY_BYTES,
} from '../services/auto-memory/index.js'
import type { AutoMemoryConfig, Message } from '../core/types.js'
import { expandAttachmentMessagesForAPI } from '../utils/messages.js'
import { createAttachmentMessage } from '../utils/attachments.js'
import type { IProvider } from '../core/llm/types.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

const stubProvider = {
  chatModel: () => {
    throw new Error('should not call real model')
  },
  streamTextExtras: () => ({}),
  defaultModelId: () => 'stub',
  describe: () => 'stub',
} as unknown as IProvider

const baseConfig: AutoMemoryConfig = {
  enabled: true,
  extractEveryNTurns: 1,
  cacheSafe: true,
  prefetchEnabled: true,
  prefetchModelTier: 'small',
}

async function main(): Promise<void> {
  // memoryAge
  {
    const now = Date.now()
    assert(memoryAgeDays(now) === 0, 'today age days')
    assert(memoryAge(now) === 'today', 'today label')
    assert(memoryFreshnessText(now) === '', 'no caveat today')
    const d3 = now - 3 * 86_400_000
    assert(memoryAgeDays(d3) === 3, '3 days')
    assert(memoryAge(d3) === '3 days ago', '3 days label')
    assert(memoryFreshnessText(d3).includes('3 days old'), 'stale caveat')
    const h = memoryHeader('/tmp/x.md', d3)
    assert(h.includes('Memory: /tmp/x.md:'), 'header path')
    assert(h.includes('point-in-time'), 'header includes freshness')
    console.log('ok memoryAge')
  }

  // manifest
  {
    const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-manifest-'))
    ensureAutoMemDir(mem)
    const mtime = Date.UTC(2026, 7, 1, 12, 0, 0)
    const topic = path.join(mem, 'prefer-concise.md')
    fs.writeFileSync(
      topic,
      `---\nname: Prefer concise\ndescription: short answers\ntype: feedback\n---\n\nbody\n`,
      'utf-8',
    )
    fs.utimesSync(topic, new Date(mtime), new Date(mtime))
    const files = scanMemoryFiles(mem)
    assert(files.length === 1, 'one topic')
    assert(files[0]!.filename === 'prefer-concise.md', 'filename')
    assert(files[0]!.filePath === topic, 'filePath')
    const manifest = formatMemoryManifest(files)
    assert(
      manifest.includes('[feedback] prefer-concise.md'),
      `manifest type+file: ${manifest}`,
    )
    assert(manifest.includes('short answers'), 'manifest description')
    assert(manifest.includes('2026-08-01T'), 'manifest ISO time')
    fs.rmSync(mem, { recursive: true, force: true })
    console.log('ok manifest')
  }

  // findRelevant
  {
    const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-find-'))
    ensureAutoMemDir(mem)
    fs.writeFileSync(
      path.join(mem, 'a.md'),
      `---\nname: A\ndescription: alpha pref\ntype: user\n---\n\nAlpha body\n`,
    )
    fs.writeFileSync(
      path.join(mem, 'b.md'),
      `---\nname: B\ndescription: beta pref\ntype: feedback\n---\n\nBeta body\n`,
    )

    const selected = await findRelevantMemories(
      'what are my prefs',
      mem,
      {
        provider: stubProvider,
        modelId: 'stub',
        selectFn: async () => ['a.md', 'missing.md', 'b.md'],
      },
      [],
      new Set(),
    )
    assert(selected.length === 2, 'filters unknown filenames')
    assert(selected[0]!.path.endsWith('a.md'), 'order a')
    assert(selected[1]!.path.endsWith('b.md'), 'order b')

    const surfaced = await readMemoriesForSurfacing(selected)
    assert(surfaced.length === 2, 'surfaced both')
    assert(surfaced[0]!.content.includes('Alpha body'), 'content a')
    assert(typeof surfaced[0]!.header === 'string', `header type ${typeof surfaced[0]!.header}`)
    assert(surfaced[0]!.header.length > 0, `header empty: ${JSON.stringify(surfaced[0])}`)

    const skipped = await findRelevantMemories(
      'what are my prefs again',
      mem,
      {
        provider: stubProvider,
        modelId: 'stub',
        selectFn: async (_q, memories) => {
          assert(memories.length === 1, 'only unsaved candidate')
          return memories.map(m => m.filename)
        },
      },
      [],
      new Set([selected[0]!.path]),
    )
    assert(
      skipped.length === 1 && skipped[0]!.path.endsWith('b.md'),
      'surfaced skip',
    )

    fs.rmSync(mem, { recursive: true, force: true })
    console.log('ok findRelevant')
  }

  // truncation
  {
    const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-trunc-'))
    ensureAutoMemDir(mem)
    const big = path.join(mem, 'big.md')
    const body = 'x'.repeat(MAX_MEMORY_BYTES + 500)
    fs.writeFileSync(
      big,
      `---\nname: Big\ndescription: huge\ntype: project\n---\n\n${body}\n`,
    )
    const st = fs.statSync(big)
    const [surf] = await readMemoriesForSurfacing([
      { path: big, mtimeMs: st.mtimeMs },
    ])
    assert(surf, 'surfaced')
    assert(surf!.content.includes('truncated'), 'truncation note')
    assert(surf!.limit != null, 'limit set')
    fs.rmSync(mem, { recursive: true, force: true })
    console.log('ok truncation')
  }

  // collect + expand
  {
    const att = createAttachmentMessage({
      type: 'relevant_memories',
      memories: [
        {
          path: '/tmp/a.md',
          content: 'hello world',
          mtimeMs: Date.now(),
          header: 'Memory (saved today): /tmp/a.md:',
        },
      ],
    })
    const msgs: Message[] = [att]
    const collected = collectSurfacedMemories(msgs)
    assert(collected.paths.has('/tmp/a.md'), 'path tracked')
    assert(collected.totalBytes === 'hello world'.length, 'bytes tracked')

    const expanded = expandAttachmentMessagesForAPI(msgs)
    assert(expanded.length === 1, 'one user msg')
    const u = expanded[0]!
    assert('role' in u && u.role === 'user', 'role user')
    assert('isMeta' in u && u.isMeta === true, 'isMeta')
    const text = typeof u.content === 'string' ? u.content : ''
    assert(text.includes('<system-reminder>'), 'system-reminder wrap')
    assert(text.includes('hello world'), 'body present')
    console.log('ok collect+expand')
  }

  // prefetch consume
  {
    const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-pref-'))
    ensureAutoMemDir(mem)
    fs.writeFileSync(
      path.join(mem, 'c.md'),
      `---\nname: C\ndescription: concise style\ntype: feedback\n---\n\nBe brief\n`,
    )

    const none = startRelevantMemoryPrefetch([{ role: 'user', content: 'hi' }], {
      config: baseConfig,
      memPath: mem,
      provider: stubProvider,
      modelId: 'stub',
      queryText: 'hi',
    })
    assert(none === undefined, 'single word skipped')

    const handle = startRelevantMemoryPrefetch(
      [{ role: 'user', content: 'please be concise in replies' }],
      {
        config: baseConfig,
        memPath: mem,
        provider: stubProvider,
        modelId: 'stub',
        queryText: 'please be concise in replies',
        selectFn: async () => ['c.md'],
      },
    )
    assert(handle, 'prefetch started')
    await handle!.promise
    assert(handle!.settledAt !== null, 'settled')

    const atts = await consumeMemoryPrefetchIfReady(handle, undefined, 0)
    assert(atts.length === 1, 'consumed once')
    assert(atts[0]!.attachment.type === 'relevant_memories', 'type')
    const again = await consumeMemoryPrefetchIfReady(handle, undefined, 1)
    assert(again.length === 0, 'no double consume')

    handle!.dispose()
    fs.rmSync(mem, { recursive: true, force: true })
    console.log('ok prefetch consume')
  }

  console.log('\nAll memory-prefetch tests passed.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

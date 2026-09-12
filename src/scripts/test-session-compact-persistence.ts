/**
 * Append-only compaction persistence, restart, multi-boundary, and legacy
 * checkpoint compatibility coverage.
 *
 * Run: npx tsx src/scripts/test-session-compact-persistence.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Message } from '../core/types.js'
import {
  createCompactBoundaryMessage,
  getMessagesAfterCompactBoundary,
} from '../core/messages/compact-boundary.js'
import {
  appendCompaction,
  appendMessage,
  createSession,
  deleteSession,
  getSession,
  getSessionTranscriptPath,
} from '../session/index.js'
import { stringifySessionJsonLine } from '../session/json-serialize.js'
import { sessionJsonlToUIMessages } from '../server/session-ui.js'

type Inspection = {
  fullIds: Array<string | null>
  activeIds: Array<string | null>
  uiTypes: string[]
  uiUsers: string[]
}

function inspect(sessionId: string, agentHome: string): Inspection {
  const session = getSession(sessionId, { agentHome })
  assert.ok(session, 'session should restore from disk')
  const active = getMessagesAfterCompactBoundary(session.messages)
  const ui = sessionJsonlToUIMessages(sessionId) as Array<
    Record<string, unknown>
  >
  return {
    fullIds: session.messages.map(message => message.uuid ?? null),
    activeIds: active.map(message => message.uuid ?? null),
    uiTypes: ui.map(message => String(message.type)),
    uiUsers: ui
      .filter(message => message.type === 'user')
      .map(message => String(message.content)),
  }
}

if (process.argv[2] === '--inspect') {
  console.log(JSON.stringify(inspect(process.argv[3]!, process.argv[4]!)))
  process.exit(0)
}

if (process.argv[2] === '--migrate-and-compact') {
  const sessionId = process.argv[3]!
  const agentHome = process.argv[4]!
  const session = getSession(sessionId, { agentHome })
  assert.ok(session)
  assert.equal(session.messages.length, 2)
  const kept = session.messages[1]!
  assert.ok(kept.uuid)
  const boundary = createCompactBoundaryMessage('auto', 20, kept.uuid)
  boundary.uuid = 'migration-boundary'
  const summary = user('migration compact summary', 'migration-summary', true)
  boundary.compactMetadata.preservedSegment = {
    headUuid: kept.uuid,
    anchorUuid: summary.uuid!,
    tailUuid: kept.uuid,
  }
  session.messages.push(boundary, summary)
  appendCompaction(sessionId, [boundary, summary])
  console.log(JSON.stringify({ keptUuid: kept.uuid }))
  process.exit(0)
}

function restartedInspection(sessionId: string, agentHome: string): Inspection {
  const run = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(import.meta.url),
      '--inspect',
      sessionId,
      agentHome,
    ],
    { encoding: 'utf8', cwd: process.cwd() },
  )
  assert.equal(run.status, 0, run.stderr)
  const lastLine = run.stdout.trim().split(/\r?\n/).at(-1)
  assert.ok(lastLine, 'restart inspector should emit JSON')
  return JSON.parse(lastLine) as Inspection
}

function user(
  content: string,
  uuid?: string,
  isCompactSummary = false,
): Message {
  return {
    role: 'user',
    content,
    ...(uuid ? { uuid } : {}),
    ...(isCompactSummary ? { isCompactSummary: true } : {}),
  }
}

function appendAndTrack(
  sessionId: string,
  messages: Message[],
  message: Message,
): void {
  messages.push(message)
  appendMessage(sessionId, message)
}

const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-persist-'))
const sessionsToDelete: string[] = []

try {
  const modern = createSession({ agentHome, cwd: process.cwd() })
  sessionsToDelete.push(modern.id)
  appendAndTrack(modern.id, modern.messages, user('old', 'old'))
  appendAndTrack(modern.id, modern.messages, user('kept', 'kept'))

  const firstBoundary = createCompactBoundaryMessage('manual', 100, 'kept')
  firstBoundary.uuid = 'boundary-1'
  firstBoundary.compactMetadata.preservedSegment = {
    headUuid: 'kept',
    anchorUuid: 'summary-1',
    tailUuid: 'kept',
  }
  const firstSummary = user('first compact summary', 'summary-1', true)
  const attachment: Message = {
    type: 'attachment',
    uuid: 'attachment-1',
    timestamp: '2026-09-12T00:00:00.000Z',
    attachment: { type: 'skill_listing', content: 'remember' },
  }
  modern.messages.push(firstBoundary, firstSummary, attachment)
  appendCompaction(modern.id, [firstBoundary, firstSummary, attachment])
  appendAndTrack(modern.id, modern.messages, user('middle', 'middle'))

  const secondBoundary = createCompactBoundaryMessage('auto', 80, 'middle')
  secondBoundary.uuid = 'boundary-2'
  const secondSummary = user('second compact summary', 'summary-2', true)
  const restoredAttachment: Message = {
    type: 'attachment',
    uuid: 'attachment-2',
    timestamp: '2026-09-12T00:01:00.000Z',
    attachment: { type: 'skill_listing', content: 'active after restart' },
  }
  modern.messages.push(secondBoundary, secondSummary, restoredAttachment)
  appendCompaction(modern.id, [
    secondBoundary,
    secondSummary,
    restoredAttachment,
  ])
  appendAndTrack(modern.id, modern.messages, user('latest', 'latest'))

  const modernPath = getSessionTranscriptPath(modern.id)!
  const modernRows = fs
    .readFileSync(modernPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line) as Record<string, unknown>)
  assert.equal(
    modernRows.some(row => row.type === 'compacted'),
    false,
    'new compactions must not write legacy checkpoints',
  )
  assert.equal(
    modernRows.filter(
      row => row.type === 'message' && row.subtype === 'compact_boundary',
    ).length,
    2,
  )

  const modernRestart = restartedInspection(modern.id, agentHome)
  assert.deepEqual(modernRestart.fullIds, [
    'old',
    'kept',
    'boundary-1',
    'summary-1',
    'attachment-1',
    'middle',
    'boundary-2',
    'summary-2',
    'attachment-2',
    'latest',
  ])
  assert.deepEqual(modernRestart.activeIds, [
    'boundary-2',
    'summary-2',
    'attachment-2',
    'latest',
  ])
  assert.equal(
    modernRestart.uiTypes.filter(type => type === 'compact_boundary').length,
    2,
  )
  assert.equal(modernRestart.uiUsers.includes('first compact summary'), false)
  assert.equal(modernRestart.uiUsers.includes('second compact summary'), false)

  const legacy = createSession({ agentHome, cwd: process.cwd() })
  sessionsToDelete.push(legacy.id)
  appendAndTrack(legacy.id, legacy.messages, user('legacy old'))
  appendAndTrack(legacy.id, legacy.messages, user('legacy kept one'))
  appendAndTrack(legacy.id, legacy.messages, user('legacy kept two'))
  const legacySummary = user('legacy compact summary', 'legacy-summary', true)
  const legacyTail = [
    user('legacy kept one', 'legacy-kept-1'),
    user('legacy kept two', 'legacy-kept-2'),
  ]
  const legacyAttachment: Message = {
    type: 'attachment',
    uuid: 'legacy-attachment',
    timestamp: '2026-09-12T00:00:00.000Z',
    attachment: { type: 'skill_listing', content: 'legacy reminder' },
  }
  fs.appendFileSync(
    getSessionTranscriptPath(legacy.id)!,
    stringifySessionJsonLine({
      type: 'compacted',
      messages: [legacySummary, ...legacyTail, legacyAttachment],
      timestamp: Date.now(),
    }) + '\n',
  )
  appendMessage(legacy.id, user('legacy latest', 'legacy-latest'))

  const legacyRestart = restartedInspection(legacy.id, agentHome)
  assert.equal(legacyRestart.fullIds.length, 7)
  assert.ok(legacyRestart.fullIds.slice(0, 3).every(Boolean))
  assert.deepEqual(legacyRestart.activeIds.slice(1), [
    'legacy-summary',
    legacyRestart.fullIds[1],
    legacyRestart.fullIds[2],
    'legacy-attachment',
    'legacy-latest',
  ])
  assert.equal(
    legacyRestart.uiTypes.filter(type => type === 'compact_boundary').length,
    1,
  )
  assert.deepEqual(legacyRestart.uiUsers, [
    'legacy old',
    'legacy kept one',
    'legacy kept two',
    'legacy latest',
  ])

  const missingLegacy = createSession({ agentHome, cwd: process.cwd() })
  sessionsToDelete.push(missingLegacy.id)
  appendAndTrack(
    missingLegacy.id,
    missingLegacy.messages,
    user('checkpoint base', 'checkpoint-base'),
  )
  const missingAssistant: Message = {
    role: 'assistant',
    uuid: 'snapshot-assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'snapshot-call',
        toolName: 'Bash',
        input: { command: 'echo legacy' },
      },
    ],
  }
  const missingTool: Message = {
    role: 'tool',
    uuid: 'snapshot-tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'snapshot-call',
        toolName: 'Bash',
        output: { type: 'text', value: 'legacy output' },
      },
    ],
  }
  fs.appendFileSync(
    getSessionTranscriptPath(missingLegacy.id)!,
    stringifySessionJsonLine({
      type: 'compacted',
      messages: [
        user('missing legacy summary', 'missing-summary', true),
        missingAssistant,
        missingTool,
        {
          type: 'attachment',
          uuid: 'missing-attachment',
          timestamp: '2026-09-12T00:02:00.000Z',
          attachment: { type: 'skill_listing', content: 'after boundary' },
        },
      ],
      timestamp: Date.now(),
    }) + '\n',
  )
  const missingRestart = restartedInspection(missingLegacy.id, agentHome)
  assert.deepEqual(missingRestart.fullIds.slice(0, 3), [
    'checkpoint-base',
    'snapshot-assistant',
    'snapshot-tool',
  ])
  assert.deepEqual(missingRestart.activeIds.slice(1), [
    'missing-summary',
    'snapshot-assistant',
    'snapshot-tool',
    'missing-attachment',
  ])

  const migration = createSession({ agentHome, cwd: process.cwd() })
  sessionsToDelete.push(migration.id)
  const migrationPath = getSessionTranscriptPath(migration.id)!
  fs.appendFileSync(
    migrationPath,
    stringifySessionJsonLine({
      type: 'message',
      role: 'user',
      content: 'old no uuid',
      timestamp: Date.now(),
    }) +
      '\n' +
      stringifySessionJsonLine({
        type: 'message',
        role: 'user',
        content: 'preserved no uuid',
        timestamp: Date.now(),
      }) +
      '\n',
  )
  const migrateRun = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(import.meta.url),
      '--migrate-and-compact',
      migration.id,
      agentHome,
    ],
    { encoding: 'utf8', cwd: process.cwd() },
  )
  assert.equal(migrateRun.status, 0, migrateRun.stderr)
  const migrationInfo = JSON.parse(
    migrateRun.stdout.trim().split(/\r?\n/).at(-1)!,
  ) as { keptUuid: string }
  const migrationRestart = restartedInspection(migration.id, agentHome)
  assert.deepEqual(migrationRestart.activeIds, [
    'migration-boundary',
    'migration-summary',
    migrationInfo.keptUuid,
  ])
  const migratedRows = fs.readFileSync(migrationPath, 'utf8')
  assert.match(migratedRows, /"type":"message_uuid_migrated"/)

  console.log('[PASS] append-only compact persistence and restart')
  console.log('[PASS] multiple boundaries retain complete UI history')
  console.log('[PASS] legacy checkpoint preserves history without tail copies')
  console.log('[PASS] missing legacy snapshot messages survive replay')
  console.log('[PASS] append-only UUID migration survives modern compact')
} finally {
  for (const sessionId of sessionsToDelete) deleteSession(sessionId)
  fs.rmSync(agentHome, { recursive: true, force: true })
}

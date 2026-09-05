/**
 * Session live SSE hub (scheduled-turn fan-out).
 * Run: npx tsx src/scripts/test-session-live.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'http'
import {
  createSessionLiveTransport,
  emitToSessionLive,
  subscribeSessionLive,
} from '../services/session-live-hub.js'

function fakeRes() {
  const ee = new EventEmitter()
  const chunks: string[] = []
  const res = {
    writableEnded: false,
    chunks,
    write(chunk: string) {
      chunks.push(chunk)
      return true
    },
    on(event: string, fn: () => void) {
      ee.on(event, fn)
      return res
    },
    emitClose() {
      ee.emit('close')
    },
  }
  return res
}

async function main() {
  const a = fakeRes()
  const unsub = subscribeSessionLive(
    'sess-live',
    a as unknown as ServerResponse,
  )
  emitToSessionLive('sess-live', { type: 'keep_alive' })
  assert.ok(a.chunks.some(c => c.includes('keep_alive')))

  const transport = createSessionLiveTransport('sess-live')
  transport.emit({
    type: 'system',
    subtype: 'scheduled_turn',
    session_id: 'sess-live',
    prompt: 'hello from cron',
  })
  transport.end()
  assert.ok(a.chunks.some(c => c.includes('scheduled_turn')))
  assert.ok(a.chunks.some(c => c.includes('hello from cron')))
  assert.equal(a.writableEnded, false)

  unsub()
  const n = a.chunks.length
  emitToSessionLive('sess-live', { type: 'keep_alive' })
  assert.equal(a.chunks.length, n)

  const b = fakeRes()
  subscribeSessionLive('sess-live', b as unknown as ServerResponse)
  b.emitClose()
  emitToSessionLive('sess-live', { type: 'keep_alive' })
  assert.equal(b.chunks.length, 0)

  const healthy = fakeRes()
  const broken = {
    writableEnded: false,
    write() {
      throw new Error('EPIPE')
    },
    on() {
      return broken
    },
    destroy() {},
  }
  subscribeSessionLive('sess-epipe', healthy as unknown as ServerResponse)
  subscribeSessionLive('sess-epipe', broken as unknown as ServerResponse)
  emitToSessionLive('sess-epipe', { type: 'keep_alive' })
  assert.ok(healthy.chunks.some(c => c.includes('keep_alive')))

  console.log('[ok] session live hub')
}

void main().catch(err => {
  console.error(err)
  process.exit(1)
})

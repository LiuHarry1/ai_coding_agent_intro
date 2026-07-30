/**
 * RuntimePort backed by a child process (or SSH) stdio NDJSON channel.
 */
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import type { Readable, Writable } from 'stream'
import type { RuntimePort, WorkspaceHandle } from './types.js'
import type {
  RuntimeClientMessage,
  RuntimeServerMessage,
} from './runtime-protocol.js'
import { onNdjsonLines, writeNdjson } from './stdio-framing.js'

export type StdioRuntimePortOptions = {
  workspace: WorkspaceHandle
  stdin: Writable
  stdout: Readable
  /** Optional stderr logging */
  stderr?: Readable
  child?: ChildProcess
  /** Kill/cleanup when port closes */
  onClose?: () => void | Promise<void>
  workerVersion?: string
}

export class StdioRuntimePort implements RuntimePort {
  readonly workspace: WorkspaceHandle
  private ee = new EventEmitter()
  private closed = false
  private stdin: Writable
  private child?: ChildProcess
  private onCloseHook?: () => void | Promise<void>
  private unsub: () => void
  private ready = false
  private readyWaiters: Array<() => void> = []

  constructor(opts: StdioRuntimePortOptions) {
    this.workspace = opts.workspace
    this.stdin = opts.stdin
    this.child = opts.child
    this.onCloseHook = opts.onClose

    this.unsub = onNdjsonLines(
      opts.stdout,
      msg => {
        const m = msg as RuntimeServerMessage
        if (m.type === 'ready') {
          this.ready = true
          for (const w of this.readyWaiters) w()
          this.readyWaiters = []
        }
        this.ee.emit('message', m)
      },
      err => {
        this.ee.emit('message', {
          type: 'error',
          message: err.message,
        } satisfies RuntimeServerMessage)
      },
    )

    opts.stderr?.on('data', (d: Buffer) => {
      const text = d.toString('utf8').trim()
      if (text) console.error(`[worker:${this.workspace.environmentId}] ${text}`)
    })

    this.child?.on('exit', (code, signal) => {
      if (this.closed) return
      this.ee.emit('message', {
        type: 'error',
        message: `Worker exited (code=${code}, signal=${signal})`,
      } satisfies RuntimeServerMessage)
      void this.close()
    })
  }

  /** Wait until Worker sends `ready` (after bind). */
  waitUntilReady(timeoutMs = 60_000): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Worker ready timed out'))
      }, timeoutMs)
      this.readyWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  send(msg: RuntimeClientMessage): void {
    if (this.closed) return
    try {
      writeNdjson(this.stdin, msg)
    } catch (err) {
      this.ee.emit('message', {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      } satisfies RuntimeServerMessage)
    }
  }

  onMessage(handler: (msg: RuntimeServerMessage) => void): () => void {
    this.ee.on('message', handler)
    return () => this.ee.off('message', handler)
  }

  interrupt(): void {
    this.send({ type: 'interrupt', runId: '*' })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.send({ type: 'shutdown' })
    } catch {
      /* ignore */
    }
    this.unsub()
    this.ee.removeAllListeners()
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM')
    }
    await this.onCloseHook?.()
  }

  async health(): Promise<'ok' | 'dead'> {
    if (this.closed) return 'dead'
    return new Promise(resolve => {
      const id = `h-${Date.now()}`
      const timer = setTimeout(() => {
        off()
        resolve('dead')
      }, 5_000)
      const off = this.onMessage(msg => {
        if (msg.type === 'pong' && msg.id === id) {
          clearTimeout(timer)
          off()
          resolve('ok')
        }
      })
      this.send({ type: 'ping', id })
    })
  }
}

/** Open RuntimePort: send bind and wait for ready. */
export async function bindStdioRuntime(
  port: StdioRuntimePort,
  workspace: WorkspaceHandle,
  timeoutMs = 60_000,
): Promise<void> {
  const wait = port.waitUntilReady(timeoutMs)
  port.send({ type: 'bind', workspace })
  await wait
}

import * as path from 'path'
import { pathToFileURL } from 'url'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import { createLspClient, type LspClient } from './client.js'
import type { LspServerState, ScopedLspServerConfig } from './types.js'

const CONTENT_MODIFIED = -32801
const MAX_TRANSIENT_RETRIES = 3
const RETRY_BASE_MS = 500

export interface LspServerInstance {
  readonly name: string
  readonly config: ScopedLspServerConfig
  readonly state: LspServerState
  readonly lastError: Error | undefined
  start(): Promise<void>
  stop(): Promise<void>
  isHealthy(): boolean
  sendRequest<T>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void): void
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void
}

export function createLspServerInstance(
  name: string,
  config: ScopedLspServerConfig,
): LspServerInstance {
  let state: LspServerState = 'stopped'
  let lastError: Error | undefined
  let crashCount = 0
  const client: LspClient = createLspClient(name, error => {
    state = 'error'
    lastError = error
    crashCount++
  })

  async function start(): Promise<void> {
    if (state === 'running' || state === 'starting') return

    const maxRestarts = config.maxRestarts ?? 3
    if (state === 'error' && crashCount > maxRestarts) {
      throw new Error(
        `LSP server '${name}' exceeded max restart attempts (${maxRestarts})`,
      )
    }

    try {
      state = 'starting'
      await client.start(config.command, config.args ?? [], {
        cwd: config.workspaceFolder,
        env: config.env,
      })

      const workspaceUri = pathToFileURL(config.workspaceFolder).href
      const params: InitializeParams = {
        processId: process.pid,
        rootPath: config.workspaceFolder,
        rootUri: workspaceUri,
        workspaceFolders: [
          {
            uri: workspaceUri,
            name: path.basename(config.workspaceFolder),
          },
        ],
        initializationOptions: config.initializationOptions ?? {},
        capabilities: {
          workspace: {
            configuration: false,
            workspaceFolders: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              didSave: true,
              willSave: false,
              willSaveWaitUntil: false,
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
              versionSupport: false,
              codeDescriptionSupport: true,
              dataSupport: false,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: true,
            },
            references: { dynamicRegistration: false },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            implementation: { dynamicRegistration: false },
            callHierarchy: { dynamicRegistration: false },
          },
          general: {
            positionEncodings: ['utf-16'],
          },
        },
      }

      const initialize = client.initialize(params)
      if (config.startupTimeout) {
        await withTimeout(
          initialize,
          config.startupTimeout,
          `LSP server '${name}' timed out during initialization`,
        )
      } else {
        await initialize
      }

      state = 'running'
      lastError = undefined
      crashCount = 0
    } catch (err) {
      state = 'error'
      lastError = err instanceof Error ? err : new Error(String(err))
      void client.stop().catch(() => undefined)
      throw lastError
    }
  }

  async function stop(): Promise<void> {
    if (state === 'stopped' || state === 'stopping') return
    try {
      state = 'stopping'
      await client.stop()
      state = 'stopped'
    } catch (err) {
      state = 'error'
      lastError = err instanceof Error ? err : new Error(String(err))
      throw lastError
    }
  }

  function isHealthy(): boolean {
    return state === 'running' && client.isInitialized
  }

  async function sendRequest<T>(
    method: string,
    params: unknown,
  ): Promise<T> {
    if (!isHealthy()) {
      throw new Error(
        `Cannot send ${method} to LSP server '${name}' while it is ${state}` +
          (lastError ? `: ${lastError.message}` : ''),
      )
    }

    let last: unknown
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      try {
        return await client.sendRequest<T>(method, params)
      } catch (err) {
        last = err
        const code = (err as { code?: number }).code
        if (code === CONTENT_MODIFIED && attempt < MAX_TRANSIENT_RETRIES) {
          await sleep(RETRY_BASE_MS * Math.pow(2, attempt))
          continue
        }
        break
      }
    }

    throw new Error(
      `LSP request '${method}' failed for '${name}': ${
        last instanceof Error ? last.message : String(last)
      }`,
    )
  }

  async function sendNotification(
    method: string,
    params: unknown,
  ): Promise<void> {
    if (!isHealthy()) {
      throw new Error(
        `Cannot send ${method} to LSP server '${name}' while it is ${state}`,
      )
    }
    await client.sendNotification(method, params)
  }

  return {
    name,
    config,
    get state() {
      return state
    },
    get lastError() {
      return lastError
    },
    start,
    stop,
    isHealthy,
    sendRequest,
    sendNotification,
    onNotification: client.onNotification,
    onRequest: client.onRequest,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

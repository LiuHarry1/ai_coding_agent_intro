import * as path from 'path'
import { pathToFileURL } from 'url'
import type { LspServerConfig } from '../../core/types.js'
import {
  convertPublishDiagnostics,
  registerPendingLspDiagnostics,
} from './diagnostics.js'
import {
  createLspServerInstance,
  type LspServerInstance,
} from './server-instance.js'
import type { ScopedLspServerConfig } from './types.js'

export interface LspServerManager {
  readonly workspaceKey: string
  getServerForFile(filePath: string): LspServerInstance | undefined
  ensureServerStarted(filePath: string): Promise<LspServerInstance | undefined>
  sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined>
  openFile(filePath: string, content: string): Promise<void>
  changeFile(filePath: string, content: string): Promise<void>
  saveFile(filePath: string): Promise<void>
  closeFile(filePath: string): Promise<void>
  isFileOpen(filePath: string): boolean
  getAllServers(): Map<string, LspServerInstance>
  shutdown(): Promise<void>
}

export function createLspServerManager(
  cwd: string,
  configs: Record<string, LspServerConfig>,
  workspaceKey: string,
): LspServerManager {
  const servers = new Map<string, LspServerInstance>()
  const extensionMap = new Map<string, string[]>()
  const openedFiles = new Map<string, string>()
  const documentVersions = new Map<string, number>()

  for (const [name, raw] of Object.entries(configs)) {
    const config = normalizeConfig(name, raw, cwd)
    if (!config) continue

    const instance = createLspServerInstance(name, config)
    instance.onRequest(
      'workspace/configuration',
      (params: { items?: unknown[] }) => (params.items ?? []).map(() => null),
    )
    instance.onNotification('textDocument/publishDiagnostics', params => {
      if (!isPublishDiagnosticsParams(params)) return
      const files = convertPublishDiagnostics(params)
      const diagCount = files.reduce(
        (sum, file) => sum + file.diagnostics.length,
        0,
      )
      const filePath = files[0]?.uri ?? params.uri
      console.log(
        `[lsp:diagnostics] publish server=${name} file=${filePath} diagnostics=${diagCount}`,
      )
      if (files.some(file => file.diagnostics.length > 0)) {
        registerPendingLspDiagnostics(workspaceKey, name, files)
      }
    })

    servers.set(name, instance)
    for (const ext of Object.keys(config.extensionToLanguage)) {
      const normalized = ext.toLowerCase()
      const names = extensionMap.get(normalized) ?? []
      names.push(name)
      extensionMap.set(normalized, names)
    }
  }

  function getServerForFile(filePath: string): LspServerInstance | undefined {
    const ext = path.extname(filePath).toLowerCase()
    const serverName = extensionMap.get(ext)?.[0]
    return serverName ? servers.get(serverName) : undefined
  }

  async function ensureServerStarted(
    filePath: string,
  ): Promise<LspServerInstance | undefined> {
    const server = getServerForFile(filePath)
    if (!server) return undefined
    if (server.state === 'stopped' || server.state === 'error') {
      await server.start()
    }
    return server
  }

  async function sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    const server = await ensureServerStarted(filePath)
    if (!server) return undefined
    return server.sendRequest<T>(method, params)
  }

  async function openFile(filePath: string, content: string): Promise<void> {
    const absolutePath = path.resolve(filePath)
    const server = await ensureServerStarted(absolutePath)
    if (!server) {
      console.log(
        `[lsp:diagnostics] open skip file=${absolutePath} reason=no-server`,
      )
      return
    }

    const uri = pathToFileURL(absolutePath).href
    if (openedFiles.get(uri) === server.name) return

    const ext = path.extname(absolutePath).toLowerCase()
    const languageId = server.config.extensionToLanguage[ext] ?? 'plaintext'
    const version = 1
    console.log(
      `[lsp:diagnostics] open server=${server.name} file=${absolutePath} language=${languageId}`,
    )
    await server.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version, text: content },
    })
    openedFiles.set(uri, server.name)
    documentVersions.set(uri, version)
  }

  async function changeFile(filePath: string, content: string): Promise<void> {
    const absolutePath = path.resolve(filePath)
    const server = getServerForFile(absolutePath)
    if (!server || server.state !== 'running') {
      await openFile(absolutePath, content)
      return
    }

    const uri = pathToFileURL(absolutePath).href
    if (openedFiles.get(uri) !== server.name) {
      await openFile(absolutePath, content)
      return
    }

    const version = (documentVersions.get(uri) ?? 1) + 1
    documentVersions.set(uri, version)
    await server.sendNotification('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    })
  }

  async function saveFile(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath)
    const server = getServerForFile(absolutePath)
    if (!server) {
      console.log(
        `[lsp:diagnostics] save skip file=${absolutePath} reason=no-server`,
      )
      return
    }
    if (server.state !== 'running') {
      console.log(
        `[lsp:diagnostics] save skip file=${absolutePath} server=${server.name} state=${server.state}`,
      )
      return
    }
    console.log(
      `[lsp:diagnostics] save server=${server.name} file=${absolutePath}`,
    )
    await server.sendNotification('textDocument/didSave', {
      textDocument: { uri: pathToFileURL(absolutePath).href },
    })
  }

  async function closeFile(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath)
    const server = getServerForFile(absolutePath)
    if (!server || server.state !== 'running') return

    const uri = pathToFileURL(absolutePath).href
    await server.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    })
    openedFiles.delete(uri)
    documentVersions.delete(uri)
  }

  function isFileOpen(filePath: string): boolean {
    return openedFiles.has(pathToFileURL(path.resolve(filePath)).href)
  }

  async function shutdown(): Promise<void> {
    const results = await Promise.allSettled(
      [...servers.values()].map(server => server.stop()),
    )
    servers.clear()
    extensionMap.clear()
    openedFiles.clear()
    documentVersions.clear()

    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (errors.length > 0) {
      throw new Error(
        `Failed to stop ${errors.length} LSP server(s): ${errors
          .map(e => (e.reason instanceof Error ? e.reason.message : String(e.reason)))
          .join('; ')}`,
      )
    }
  }

  return {
    workspaceKey,
    getServerForFile,
    ensureServerStarted,
    sendRequest,
    openFile,
    changeFile,
    saveFile,
    closeFile,
    isFileOpen,
    getAllServers: () => servers,
    shutdown,
  }
}

function normalizeConfig(
  name: string,
  config: LspServerConfig,
  cwd: string,
): ScopedLspServerConfig | null {
  if (!config || typeof config.command !== 'string' || !config.command.trim()) {
    console.warn(`[lsp] skipping '${name}': missing command`)
    return null
  }
  if (
    !config.extensionToLanguage ||
    Object.keys(config.extensionToLanguage).length === 0
  ) {
    console.warn(`[lsp] skipping '${name}': missing extensionToLanguage`)
    return null
  }

  const extensionToLanguage: Record<string, string> = {}
  for (const [ext, language] of Object.entries(config.extensionToLanguage)) {
    if (!ext.startsWith('.') || !language) {
      console.warn(`[lsp] skipping invalid extension mapping '${name}:${ext}'`)
      continue
    }
    extensionToLanguage[ext.toLowerCase()] = language
  }
  if (Object.keys(extensionToLanguage).length === 0) return null

  const workspaceFolder = config.workspaceFolder
    ? path.resolve(cwd, config.workspaceFolder)
    : path.resolve(cwd)

  return {
    ...config,
    name,
    extensionToLanguage,
    workspaceFolder,
  }
}

function isPublishDiagnosticsParams(params: unknown): params is Parameters<
  typeof convertPublishDiagnostics
>[0] {
  return (
    typeof params === 'object' &&
    params !== null &&
    'uri' in params &&
    typeof (params as { uri?: unknown }).uri === 'string' &&
    'diagnostics' in params &&
    Array.isArray((params as { diagnostics?: unknown }).diagnostics)
  )
}

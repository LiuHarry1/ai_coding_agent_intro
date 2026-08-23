/**
 * Strict Zod schema for settings files (CC-aligned field names).
 * Invalid files are rejected — no silent coercion.
 */
import { z } from 'zod'

const ModelProfileSchema = z.object({
  provider: z.enum(['anthropic', 'openai', 'openai-compatible']).optional(),
  model: z.string().min(1).optional(),
  baseURL: z.string().url().optional(),
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
})

const ModelsSchema = z.object({
  large: ModelProfileSchema,
  medium: ModelProfileSchema.optional(),
  small: ModelProfileSchema.optional(),
})

const CompactionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  microCompactKeepRecent: z.number().int().positive().optional(),
  maxFilesToRestore: z.number().int().nonnegative().optional(),
  maxTokensPerFile: z.number().int().positive().optional(),
  fileBudget: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  timeBasedMicroEnabled: z.boolean().optional(),
  timeBasedMicroGapMinutes: z.number().int().positive().optional(),
})

const SessionMemoryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  minimumTokensToInit: z.number().int().nonnegative().optional(),
  minimumTokensBetweenUpdate: z.number().int().nonnegative().optional(),
  toolCallsBetweenUpdates: z.number().int().nonnegative().optional(),
  cacheSafe: z.boolean().optional(),
  modelTier: z.enum(['large', 'medium', 'small']).optional(),
  compactMinTokens: z.number().int().nonnegative().optional(),
  compactMaxTokens: z.number().int().positive().optional(),
  compactMinTextMessages: z.number().int().nonnegative().optional(),
})

const McpServerStdioSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})

const McpServerHttpSchema = z.object({
  url: z.string().url(),
  transport: z.enum(['http', 'sse']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
})

const McpServerSchema = z.union([McpServerStdioSchema, McpServerHttpSchema])

const LspServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  extensionToLanguage: z.record(z.string(), z.string()),
  env: z.record(z.string(), z.string()).optional(),
  initializationOptions: z.unknown().optional(),
  workspaceFolder: z.string().optional(),
  startupTimeout: z.number().int().positive().optional(),
  maxRestarts: z.number().int().nonnegative().optional(),
})

const AutoMemoryNestedSchema = z.object({
  enabled: z.boolean().optional(),
  directory: z.string().optional(),
  cacheSafe: z.boolean().optional(),
  modelTier: z.enum(['large', 'medium', 'small']).optional(),
  prefetchEnabled: z.boolean().optional(),
  prefetchModelTier: z.enum(['large', 'medium', 'small']).optional(),
})

const SshHostSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  sshHost: z.string().min(1),
  sshUser: z.string().optional(),
  sshPort: z.number().int().positive().optional(),
  sshIdentityFile: z.string().optional(),
  proxyJump: z.string().optional(),
  startDirectory: z.string().optional(),
})

const BrowserConfigSchema = z.object({
  mode: z.enum(['isolated', 'extension']).optional(),
  headless: z.boolean().optional(),
  cdpEndpoint: z.string().optional(),
})

/** Parsed settings layer before merge into AppConfig. */
export const SettingsFileSchema = z.object({
  models: ModelsSchema.optional(),
  compaction: CompactionConfigSchema.optional(),
  sessionMemory: SessionMemoryConfigSchema.optional(),
  autoMemoryEnabled: z.boolean().optional(),
  autoMemoryDirectory: z.string().optional(),
  autoMemoryCacheSafe: z.boolean().optional(),
  autoMemoryModelTier: z.enum(['large', 'medium', 'small']).optional(),
  autoMemory: AutoMemoryNestedSchema.optional(),
  mcpServers: z.record(z.string(), McpServerSchema).optional(),
  lspServers: z.record(z.string(), LspServerSchema).optional(),
  disabledTools: z.array(z.string()).optional(),
  browser: BrowserConfigSchema.optional(),
  environments: z
    .object({
      ssh: z.array(SshHostSchema).optional(),
    })
    .optional(),
})

export type SettingsFileJson = z.infer<typeof SettingsFileSchema>

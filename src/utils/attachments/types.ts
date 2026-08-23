import type { ReadOutput } from '../read/types.js'

export type FileAttachment = {
  type: 'file'
  filename: string
  displayPath: string
  content: ReadOutput
  truncated?: boolean
}

export type PdfReferenceAttachment = {
  type: 'pdf_reference'
  filename: string
  displayPath: string
  pageCount: number
  fileSize: number
}

export type DirectoryAttachment = {
  type: 'directory'
  path: string
  displayPath: string
  content: string
}

export type AlreadyReadFileAttachment = {
  type: 'already_read_file'
  filename: string
  displayPath: string
  content: ReadOutput
}

export type DiagnosticSeverity = 'Error' | 'Warning' | 'Info' | 'Hint'

export interface Diagnostic {
  message: string
  severity: DiagnosticSeverity
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

export interface DiagnosticFile {
  uri: string
  diagnostics: Diagnostic[]
}

export type DiagnosticsAttachment = {
  type: 'diagnostics'
  files: DiagnosticFile[]
  isNew?: boolean
}

export type PlanModeAttachment = {
  type: 'plan_mode'
  reminderType: 'full' | 'sparse'
  planFilePath: string
  planExists: boolean
}

export type PlanModeReentryAttachment = {
  type: 'plan_mode_reentry'
  planFilePath: string
}

export type PlanModeExitAttachment = {
  type: 'plan_mode_exit'
  planFilePath: string
  planExists: boolean
}

export type SkillListingAttachment = {
  type: 'skill_listing'
  content: string
}

export type AgentListingDeltaAttachment = {
  type: 'agent_listing_delta'
  addedTypes: string[]
  addedLines: string[]
  removedTypes: string[]
  isInitial: boolean
}

export type TaskNotificationAttachment = {
  type: 'task_notification'
  taskId: string
  outputFile: string
  status: 'completed' | 'failed' | 'killed'
  summary: string
  toolUseId?: string
  rawXml: string
}

/** Prefetched auto-memory topic files (CC relevant_memories). */
export type RelevantMemoriesAttachment = {
  type: 'relevant_memories'
  memories: Array<{
    path: string
    content: string
    mtimeMs: number
    header: string
    limit?: number
  }>
}

export type Attachment =
  | FileAttachment
  | PdfReferenceAttachment
  | DirectoryAttachment
  | AlreadyReadFileAttachment
  | DiagnosticsAttachment
  | PlanModeAttachment
  | PlanModeReentryAttachment
  | PlanModeExitAttachment
  | SkillListingAttachment
  | AgentListingDeltaAttachment
  | TaskNotificationAttachment
  | RelevantMemoriesAttachment

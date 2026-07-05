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

export type Attachment =
  | FileAttachment
  | PdfReferenceAttachment
  | DirectoryAttachment
  | AlreadyReadFileAttachment
  | DiagnosticsAttachment
  | PlanModeAttachment
  | PlanModeReentryAttachment
  | PlanModeExitAttachment

export interface ReadFileStateEntry {
  content: string
  timestamp: number
}

export type ReadFileState = Map<string, ReadFileStateEntry>

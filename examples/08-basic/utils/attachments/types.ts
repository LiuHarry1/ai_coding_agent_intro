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

export type Attachment =
  | FileAttachment
  | PdfReferenceAttachment
  | DirectoryAttachment
  | AlreadyReadFileAttachment

export interface ReadFileStateEntry {
  content: string
  timestamp: number
}

export type ReadFileState = Map<string, ReadFileStateEntry>

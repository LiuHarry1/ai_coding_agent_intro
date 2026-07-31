import { z } from 'zod'

export type ReadTextOutput = {
  type: 'text'
  file: {
    filePath: string
    content: string
    numLines: number
    startLine: number
    totalLines: number
  }
}

export type ReadImageOutput = {
  type: 'image'
  file: {
    filePath: string
    base64: string
    mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
    originalSize: number
  }
}

export type ReadNotebookOutput = {
  type: 'notebook'
  file: {
    filePath: string
    cells: unknown[]
  }
}

export type ReadPdfOutput = {
  type: 'pdf'
  file: {
    filePath: string
    base64: string
    originalSize: number
    pageCount: number | null
  }
}

export type ReadPdfPagesOutput = {
  type: 'pdf_pages'
  file: {
    filePath: string
    pages: string
    text: string
    pageCount: number
  }
}

export type ReadOutput =
  | ReadTextOutput
  | ReadImageOutput
  | ReadNotebookOutput
  | ReadPdfOutput
  | ReadPdfPagesOutput

/** Loose schema for UI/wire validation (CC-style outputSchema gate). */
export const ReadOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    file: z.object({
      filePath: z.string(),
      content: z.string(),
      numLines: z.number(),
      startLine: z.number(),
      totalLines: z.number(),
    }),
  }),
  z.object({
    type: z.literal('image'),
    file: z.object({
      filePath: z.string(),
      base64: z.string(),
      mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      originalSize: z.number(),
    }),
  }),
  z.object({
    type: z.literal('notebook'),
    file: z.object({
      filePath: z.string(),
      cells: z.array(z.unknown()),
    }),
  }),
  z.object({
    type: z.literal('pdf'),
    file: z.object({
      filePath: z.string(),
      base64: z.string(),
      originalSize: z.number(),
      pageCount: z.number().nullable(),
    }),
  }),
  z.object({
    type: z.literal('pdf_pages'),
    file: z.object({
      filePath: z.string(),
      pages: z.string(),
      text: z.string(),
      pageCount: z.number(),
    }),
  }),
])

export class FileTooLargeError extends Error {
  constructor(
    public sizeBytes: number,
    public maxBytes: number,
  ) {
    super(
      `File content (${Math.round(sizeBytes / 1024)} KB) exceeds maximum allowed size (${Math.round(maxBytes / 1024)} KB).`,
    )
    this.name = 'FileTooLargeError'
  }
}

export class MaxFileReadLinesExceededError extends Error {
  constructor(public totalLines: number) {
    super(`File has ${totalLines} lines; use offset/limit or grep.`)
    this.name = 'MaxFileReadLinesExceededError'
  }
}

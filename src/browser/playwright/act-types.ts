/** Closed union of in-page batch actions. Nested batch is kept; evaluate is gated at runtime. */
export type BrowserFormField = {
  ref: string
  type?: string
  value?: string | number | boolean
}

export type BrowserActRequest =
  | {
      kind: 'click'
      ref?: string
      doubleClick?: boolean
      button?: string
      modifiers?: string[]
      x?: number
      y?: number
    }
  | {
      kind: 'clickCoords'
      x: number
      y: number
      doubleClick?: boolean
      button?: string
    }
  | {
      kind: 'type'
      ref: string
      text: string
      submit?: boolean
      slowly?: boolean
    }
  | { kind: 'press'; key: string; modifiers?: string[] }
  | { kind: 'hover'; ref: string }
  | { kind: 'scrollIntoView'; ref: string }
  | { kind: 'drag'; startRef: string; endRef: string }
  | { kind: 'select'; ref: string; values: string[] }
  | { kind: 'fill'; fields: BrowserFormField[] }
  | { kind: 'resize'; width: number; height: number }
  | {
      kind: 'wait'
      timeMs?: number
      text?: string
      textGone?: string
      selector?: string
      url?: string
    }
  | { kind: 'evaluate'; fn: string; ref?: string }
  | {
      kind: 'batch'
      actions: BrowserActRequest[]
      stopOnError?: boolean
    }

export type BrowserBatchActionResult = {
  ok: boolean
  error?: string
  navigated?: true
  url?: string
}

export type BrowserBatchAbort = {
  reason: 'navigation' | 'closed'
  afterAction: number
  url: string
  skipped: number
}

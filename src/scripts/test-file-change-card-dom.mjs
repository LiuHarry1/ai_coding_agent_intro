import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(
  new URL('../../client/web/src/components/FileChangeCard.jsx', import.meta.url),
  'utf8',
)
const sharedHeaderSource = await readFile(
  new URL('../../client/web/src/components/ToolRowHeader.jsx', import.meta.url),
  'utf8',
)
const headerStart = source.indexOf("role='button'")
const copyButton = source.indexOf('<CopyButton', headerStart)
const headerEnd = source.indexOf('</div>', copyButton)
const firstHook = source.indexOf('const [expanded, setExpanded]')
const stubGuard = source.indexOf('if (!filePath && !hasAnythingToShow)')

assert.ok(headerStart >= 0, 'file-change header must be a non-button container')
assert.ok(copyButton > headerStart, 'copy action must remain in the header')
assert.ok(headerEnd > copyButton, 'header must close after the copy action')
assert.ok(firstHook >= 0, 'file-change card must retain expansion state')
assert.ok(
  firstHook < stubGuard,
  'file-change hooks must run before the streaming-arguments stub return',
)
assert.doesNotMatch(
  source.slice(Math.max(0, headerStart - 100), headerEnd),
  /<button[^>]+className='file-change-header'/,
)
assert.match(source, /onKeyDown=\{onHeaderKeyDown\}/)
assert.match(source, /e\.target !== e\.currentTarget/)

assert.doesNotMatch(
  sharedHeaderSource,
  /<button[^>]+className='tool-row-header'/,
)
assert.match(sharedHeaderSource, /role=\{onToggle \? 'button' : undefined\}/)
assert.match(sharedHeaderSource, /onKeyDown=\{onKeyDown\}/)
assert.match(sharedHeaderSource, /e\.target !== e\.currentTarget/)

console.log('ok tool-card headers avoid nested button markup')


/**
 * WebFetch checks: URL validation, redirect policy, redirect loop / size caps,
 * html→markdown, preapproved hosts, and the tool-level error paths.
 *
 * Offline by default (drives a throwaway 127.0.0.1 server). Set WEB_FETCH_LIVE=1
 * to additionally fetch a real preapproved docs page and exercise the cache.
 */
import * as http from 'http'
import type { AddressInfo } from 'net'
import { definition as webFetch } from '../tools/WebFetchTool/WebFetchTool.js'
import { isPreapprovedHost } from '../tools/WebFetchTool/preapproved.js'
import type { ToolContext } from '../core/types.js'
import {
  clearWebFetchCache,
  getURLMarkdownContent,
  getWithPermittedRedirects,
  htmlToMarkdown,
  isPermittedRedirect,
  isPreapprovedUrl,
  validateURL,
} from '../tools/WebFetchTool/utils.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

async function expectThrows(
  fn: () => Promise<unknown>,
  pattern: RegExp,
  msg: string,
): Promise<void> {
  try {
    await fn()
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    assert(pattern.test(text), `${msg} (got: ${text})`)
    return
  }
  throw new Error(`FAIL: ${msg} (did not throw)`)
}

// ── validateURL ────────────────────────────────

assert(validateURL('https://react.dev/learn'), 'normal https URL ok')
assert(validateURL('http://example.com'), 'http ok (upgraded later)')
assert(
  !validateURL(`https://example.com/${'a'.repeat(2001)}`),
  'over 2000 chars rejected',
)
assert(!validateURL('https://user:pass@example.com'), 'credentials rejected')
assert(
  !validateURL('https://intranet/secret'),
  'single-label hostname rejected',
)
assert(!validateURL('not a url'), 'unparseable rejected')

// ── isPermittedRedirect ────────────────────────

assert(
  isPermittedRedirect('https://example.com/a', 'https://example.com/b'),
  'same host different path permitted',
)
assert(
  isPermittedRedirect('https://example.com/a', 'https://www.example.com/a'),
  'adding www permitted',
)
assert(
  isPermittedRedirect('https://www.example.com/a', 'https://example.com/a'),
  'removing www permitted',
)
assert(
  !isPermittedRedirect('https://example.com/a', 'https://evil.com/a'),
  'cross host rejected',
)
assert(
  !isPermittedRedirect('https://example.com/a', 'http://example.com/a'),
  'protocol downgrade rejected',
)
assert(
  !isPermittedRedirect('https://example.com/a', 'https://example.com:8443/a'),
  'port change rejected',
)
assert(
  !isPermittedRedirect('https://example.com/a', 'https://u:p@example.com/a'),
  'redirect with credentials rejected',
)

// ── preapproved hosts ──────────────────────────

assert(isPreapprovedUrl('https://react.dev/learn'), 'react.dev preapproved')
assert(
  isPreapprovedHost('github.com', '/anthropics/claude-code'),
  'path-scoped github.com/anthropics preapproved',
)
assert(
  !isPreapprovedHost('github.com', '/anthropics-evil/malware'),
  'path prefix respects segment boundary',
)
assert(
  !isPreapprovedUrl('https://evil.com/docs'),
  'unknown host not preapproved',
)

// ── html → markdown ────────────────────────────

{
  // Turndown defaults (as CC ships them): setext h1/h2, ATX h3+, indented code.
  const md = await htmlToMarkdown(
    '<h1>Title</h1><h3>Sub</h3><p>Body <a href="https://x.dev">link</a></p><pre><code>const a = 1</code></pre>',
  )
  assert(md.includes('Title\n====='), 'h1 converted to setext heading')
  assert(md.includes('### Sub'), 'h3 converted to ATX heading')
  assert(md.includes('[link](https://x.dev)'), 'link target preserved')
  assert(
    md.includes('    const a = 1'),
    'code block preserved as indented block',
  )
}

// ── local server: redirect policy + caps ───────

const HTML_BODY =
  '<html><head><title>Doc</title></head><body><h1>Hello</h1><pre><code>x = 1</code></pre></body></html>'

const server = http.createServer((req, res) => {
  const url = req.url ?? '/'
  if (url === '/ok') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(HTML_BODY)
    return
  }
  if (url === '/hop1') {
    res.writeHead(302, { location: '/hop2' })
    res.end()
    return
  }
  if (url === '/hop2') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<p>hop2 ok</p>')
    return
  }
  if (url === '/relative') {
    res.writeHead(301, { location: 'hop2' })
    res.end()
    return
  }
  if (url === '/loop') {
    res.writeHead(302, { location: '/loop' })
    res.end()
    return
  }
  if (url === '/cross') {
    res.writeHead(302, { location: 'https://evil.example.org/landing' })
    res.end()
    return
  }
  if (url === '/nolocation') {
    res.writeHead(302)
    res.end()
    return
  }
  if (url === '/big') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(Buffer.alloc(11 * 1024 * 1024, 0x61))
    return
  }
  res.writeHead(404)
  res.end('nope')
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port
const base = `http://127.0.0.1:${port}`
const signal = new AbortController().signal

try {
  {
    const res = await getWithPermittedRedirects(
      `${base}/hop1`,
      signal,
      isPermittedRedirect,
    )
    assert(!('type' in res), 'same-host redirect followed, not reported')
    assert(res.status === 200, 'followed redirect reached 200')
    assert(
      Buffer.from(res.data).toString('utf-8').includes('hop2 ok'),
      'followed redirect returned target body',
    )
  }

  {
    const res = await getWithPermittedRedirects(
      `${base}/relative`,
      signal,
      isPermittedRedirect,
    )
    assert(!('type' in res) && res.status === 200, 'relative Location resolved')
  }

  {
    const res = await getWithPermittedRedirects(
      `${base}/cross`,
      signal,
      isPermittedRedirect,
    )
    assert(
      'type' in res && res.type === 'redirect',
      'cross-host reported, not followed',
    )
    assert(
      res.redirectUrl === 'https://evil.example.org/landing',
      'cross-host redirect target reported',
    )
    assert(res.statusCode === 302, 'cross-host status reported')
  }

  await expectThrows(
    () =>
      getWithPermittedRedirects(`${base}/loop`, signal, isPermittedRedirect),
    /Too many redirects/,
    'redirect loop capped',
  )

  await expectThrows(
    () =>
      getWithPermittedRedirects(
        `${base}/nolocation`,
        signal,
        isPermittedRedirect,
      ),
    /Redirect missing Location header/,
    'redirect without Location rejected',
  )

  await expectThrows(
    () => getWithPermittedRedirects(`${base}/big`, signal, isPermittedRedirect),
    /maxContentLength|Request failed|aborted/i,
    'oversized body rejected',
  )

  // ── tool-level wiring ────────────────────────

  const context = {
    eventBus: { emit: () => {} },
    wire: {},
  } as unknown as ToolContext
  const tool = webFetch.create(process.cwd(), context) as unknown as {
    execute: (
      args: { url: string; prompt: string },
      options?: { toolCallId?: string },
    ) => Promise<unknown>
  }

  {
    const out = await tool.execute({ url: 'not a url', prompt: 'p' })
    assert(
      typeof out === 'string' && out.startsWith('Error: Invalid URL'),
      'unparseable URL returns Error string',
    )
  }

  {
    const out = await tool.execute({
      url: 'https://intranet/secret',
      prompt: 'p',
    })
    assert(
      typeof out === 'string' && out.includes('Invalid URL'),
      'validateURL rejection surfaces as Error string',
    )
  }

  {
    const mapped = webFetch.mapToolResultToToolResultBlockParam!(
      {
        bytes: 10,
        code: 200,
        codeText: 'OK',
        result: 'distilled answer',
        durationMs: 5,
        url: 'https://react.dev',
      },
      'toolu_1',
    )
    assert(
      mapped.content === 'distilled answer',
      'mapper sends only result text',
    )
    assert(mapped.tool_use_id === 'toolu_1', 'mapper preserves tool_use_id')
    const parsed = webFetch.outputSchema!.safeParse({
      bytes: 10,
      code: 200,
      codeText: 'OK',
      result: 'x',
      durationMs: 1,
      url: 'https://react.dev',
    })
    assert(parsed.success, 'outputSchema accepts CC-shaped output')
  }
} finally {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

// ── live: real fetch + cache (opt-in) ──────────

if (process.env.WEB_FETCH_LIVE === '1') {
  clearWebFetchCache()
  const url = 'https://react.dev/learn'
  const first = await getURLMarkdownContent(url, new AbortController())
  assert(!('type' in first), 'live fetch not a redirect')
  assert(first.code === 200, 'live fetch 200')
  assert(first.content.length > 0, 'live fetch returned markdown')

  const startCached = Date.now()
  const second = await getURLMarkdownContent(url, new AbortController())
  assert(!('type' in second), 'cached entry not a redirect')
  assert(second.content === first.content, 'cache returns identical content')
  assert(Date.now() - startCached < 50, 'cache hit avoids the network')
  console.log(
    `live: ${first.bytes} bytes -> ${first.content.length} markdown chars, cache hit ok`,
  )
} else {
  console.log('live fetch skipped (set WEB_FETCH_LIVE=1 to enable)')
}

console.log('WebFetch tests OK')

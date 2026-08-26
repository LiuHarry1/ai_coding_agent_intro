/**
 * Workspace HTML preview route (search2chart-style HTTP serve).
 * Run: npx tsx src/scripts/test-workspace-preview.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { createWorkspaceRouter } from '../server/workspace/router.js'
import { getPreviewBaseUrl } from '../server/workspace/preview.js'

const SAMPLE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>t</title></head>
<body><p id="ok">search2chart-style preview</p></body></html>`

function sampleChartHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Chart</title></head>
<body>
<script>
const D={title:"Test",categories:["A","B"],seriesList:[{name:"S",data:[1,2]}],
palettes:{default:["#5470c6"]},defaultType:"bar",defaultPalette:"default",width:400,height:300};
document.body.textContent=D.title+" "+D.categories.join(",");
</script>
</body></html>`
}

async function withServer(
  root: string,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const router = createWorkspaceRouter({ root })
  const server = http.createServer(async (req, res) => {
    if (await router(req, res)) return
    res.writeHead(404).end('not found')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  assert(addr && typeof addr === 'object')
  const base = `http://127.0.0.1:${addr.port}`
  try {
    await fn(base)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()))
    })
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-preview-'))
  const chartPath = path.join(root, 'charts', 'sample.html')
  fs.mkdirSync(path.join(root, 'charts'), { recursive: true })
  fs.writeFileSync(chartPath, sampleChartHtml(), 'utf8')
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not html', 'utf8')

  const prevUrl = process.env.AGENT_PUBLIC_URL
  process.env.AGENT_PUBLIC_URL = 'http://preview.example.com'
  try {
    assert.strictEqual(getPreviewBaseUrl(), 'http://preview.example.com')

    await withServer(root, async base => {
      const metaRes = await fetch(`${base}/workspace`)
      assert.strictEqual(metaRes.status, 200)
      const meta = (await metaRes.json()) as {
        workspace: string
        previewBaseUrl?: string
      }
      assert.strictEqual(meta.workspace, root)
      assert.strictEqual(meta.previewBaseUrl, 'http://preview.example.com')

      const okRes = await fetch(
        `${base}/workspace/preview?path=${encodeURIComponent(chartPath)}`,
      )
      assert.strictEqual(okRes.status, 200)
      assert.match(okRes.headers.get('content-type') || '', /text\/html/)
      assert.match(
        okRes.headers.get('content-disposition') || '',
        /inline/i,
      )
      const body = await okRes.text()
      assert.match(body, /Test/)

      const badExt = await fetch(
        `${base}/workspace/preview?path=${encodeURIComponent(path.join(root, 'notes.txt'))}`,
      )
      assert.strictEqual(badExt.status, 400)

      const outside = path.join(os.tmpdir(), `outside-${Date.now()}.html`)
      fs.writeFileSync(outside, SAMPLE_HTML, 'utf8')
      try {
        process.env.SANDBOX_MODE = 'strict'
        const escapeRes = await fetch(
          `${base}/workspace/preview?path=${encodeURIComponent(outside)}`,
        )
        assert.strictEqual(escapeRes.status, 403)
      } finally {
        delete process.env.SANDBOX_MODE
        fs.unlinkSync(outside)
      }
    })

    console.log('workspace preview tests OK')
  } finally {
    if (prevUrl === undefined) delete process.env.AGENT_PUBLIC_URL
    else process.env.AGENT_PUBLIC_URL = prevUrl
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

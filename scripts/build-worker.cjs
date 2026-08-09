/**
 * Bundle Agent Worker to dist/worker/{slug}-worker.cjs (CJS for Node LSP deps).
 * slug comes from brand.json.
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const brand = JSON.parse(
  fs.readFileSync(path.join(root, 'brand.json'), 'utf8'),
)
const slug = brand.slug || 'baize'
const workerFile = `${slug}-worker.cjs`
const outfile = path.join(root, 'dist', 'worker', workerFile)
const versionFile = path.join(root, 'dist', 'worker', 'version.json')
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
)

async function main() {
  fs.mkdirSync(path.dirname(outfile), { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'worker', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    sourcemap: true,
    logLevel: 'info',
    define: {
      // Bundled worker always relies on AGENT_ROOT; avoid empty import.meta.url
      'import.meta.url': JSON.stringify(`file:///${workerFile}`),
    },
  })
  // Include build time so SSH ensureWorker redeploys when the bundle changes
  // (package.json version alone stays stable across rebuilds).
  const builtAt = new Date().toISOString()
  const version = `${pkg.version || '1.0.0'}+${builtAt.replace(/[-:.]/g, '').replace('T', '').replace('Z', '')}`
  fs.writeFileSync(
    versionFile,
    JSON.stringify({ version, builtAt }, null, 2),
  )
  // Remove legacy artifact name if present
  const legacy = path.join(root, 'dist', 'worker', 'baix-worker.cjs')
  const legacyMap = `${legacy}.map`
  for (const p of [legacy, legacyMap]) {
    try {
      fs.unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
  console.log(`Wrote ${outfile}`)
  console.log(`Wrote ${versionFile}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

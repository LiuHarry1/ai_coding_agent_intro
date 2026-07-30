/**
 * Bundle Agent Worker to dist/worker/baix-worker.cjs (CJS for Node LSP deps).
 */
const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const outfile = path.join(root, 'dist', 'worker', 'baix-worker.cjs')
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
      // Bundled worker always relies on BAIX_AGENT_ROOT; avoid empty import.meta.url
      'import.meta.url': JSON.stringify('file:///baix-worker.cjs'),
    },
  })
  fs.writeFileSync(
    versionFile,
    JSON.stringify(
      { version: pkg.version || '1.0.0', builtAt: new Date().toISOString() },
      null,
      2,
    ),
  )
  console.log(`Wrote ${outfile}`)
  console.log(`Wrote ${versionFile}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

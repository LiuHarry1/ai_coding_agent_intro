/**
 * Stage minimal node_modules for bundled-agent externals (sharp, playwright-core).
 * Output: dist/agent/runtime/node_modules/
 */
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const sourceRoot = path.join(root, 'node_modules')
const destRoot = path.join(root, 'dist', 'agent', 'runtime', 'node_modules')

/** Root packages the esbuild agent bundle leaves external. */
const ROOT_PACKAGES = ['sharp', 'playwright-core']

function readPkg(dir) {
  const pkgPath = path.join(dir, 'package.json')
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    if (name === '.bin') continue
    const from = path.join(src, name)
    const to = path.join(dest, name)
    const stat = fs.statSync(from)
    if (stat.isDirectory()) {
      copyRecursive(from, to)
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
    }
  }
}

function resolvePackageDir(name) {
  if (name.startsWith('@')) {
    const [scope, pkg] = name.split('/')
    const dir = path.join(sourceRoot, scope, pkg)
    return fs.existsSync(dir) ? dir : null
  }
  const dir = path.join(sourceRoot, name)
  return fs.existsSync(dir) ? dir : null
}

function stagePackage(name, copied) {
  if (copied.has(name)) return
  const srcDir = resolvePackageDir(name)
  if (!srcDir) {
    console.warn(`[stage-agent-runtime] skip missing package: ${name}`)
    return
  }
  copied.add(name)

  const destDir = name.startsWith('@')
    ? path.join(destRoot, name.split('/')[0], name.split('/')[1])
    : path.join(destRoot, name)
  copyRecursive(srcDir, destDir)

  const pkg = readPkg(srcDir)
  const deps = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  }
  for (const dep of Object.keys(deps ?? {})) {
    stagePackage(dep, copied)
  }
}

function main() {
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`Missing ${sourceRoot}. Run npm install first.`)
  }

  if (fs.existsSync(destRoot)) {
    fs.rmSync(destRoot, { recursive: true, force: true })
  }
  fs.mkdirSync(destRoot, { recursive: true })

  const copied = new Set()
  for (const pkg of ROOT_PACKAGES) {
    stagePackage(pkg, copied)
  }

  const manifest = {
    stagedAt: new Date().toISOString(),
    packages: [...copied].sort(),
    roots: ROOT_PACKAGES,
  }
  fs.writeFileSync(
    path.join(root, 'dist', 'agent', 'runtime', 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  )

  console.log(
    `[stage-agent-runtime] staged ${copied.size} packages → ${destRoot}`,
  )
}

main()

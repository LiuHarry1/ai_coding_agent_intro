/**
 * Download, verify, and stage a target-specific ripgrep binary for Electron.
 *
 * Output: dist/desktop-resources/ripgrep/{rg|rg.exe,licenses,manifest.json}
 *
 * Usage:
 *   node scripts/stage-ripgrep.cjs [--target win32-x64|darwin-x64|darwin-arm64]
 *   node scripts/stage-ripgrep.cjs --check [--target ...]
 *
 * RIPGREP_BASE_URL may point at a mirror of the pinned release directory.
 * The pinned archive SHA-256 is always enforced.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const extractZip = require('extract-zip')
const tar = require('tar')

const root = path.resolve(__dirname, '..')
const manifestPath = path.join(__dirname, 'ripgrep-manifest.json')
const sourceManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const cacheRoot = path.join(root, 'dist', 'cache', 'ripgrep')
const stageRoot = path.join(root, 'dist', 'desktop-resources', 'ripgrep')
const LICENSE_FILES = ['LICENSE-MIT', 'UNLICENSE']
const DOWNLOAD_ATTEMPTS = 3
const DOWNLOAD_TIMEOUT_MS = 180_000

function targetFor(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`
  if (!sourceManifest.targets[target]) {
    throw new Error(
      `Unsupported ripgrep target "${target}". Supported targets: ${Object.keys(
        sourceManifest.targets,
      ).join(', ')}`,
    )
  }
  return target
}

function parseArgs(argv = process.argv.slice(2)) {
  let target
  let checkOnly = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') {
      checkOnly = true
      continue
    }
    if (arg === '--target') {
      target = argv[++i]
      if (!target) throw new Error('--target requires a value')
      continue
    }
    if (arg.startsWith('--target=')) {
      target = arg.slice('--target='.length)
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  const resolvedTarget = target ?? targetFor()
  if (!sourceManifest.targets[resolvedTarget]) {
    throw new Error(
      `Unsupported ripgrep target "${resolvedTarget}". Supported targets: ${Object.keys(
        sourceManifest.targets,
      ).join(', ')}`,
    )
  }

  return { target: resolvedTarget, checkOnly }
}

function sha256File(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex')
}

function assertFileHash(filePath, expected, label) {
  const actual = sha256File(filePath)
  if (actual !== expected) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected}, received ${actual}`,
    )
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function download(url, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })

  let lastError
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    const temporary = `${destination}.tmp-${process.pid}-${attempt}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          accept: 'application/octet-stream',
          'user-agent': 'baize-desktop-build',
        },
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`)
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      fs.writeFileSync(temporary, bytes)
      fs.rmSync(destination, { force: true })
      fs.renameSync(temporary, destination)
      return
    } catch (error) {
      lastError = error
      fs.rmSync(temporary, { force: true })
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await sleep(attempt * 1000)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  throw new Error(
    `Failed to download ${url} after ${DOWNLOAD_ATTEMPTS} attempts. ` +
      `Set RIPGREP_BASE_URL to a trusted mirror if GitHub is unavailable. ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

async function ensureArchive(targetConfig, baseUrl) {
  const archivePath = path.join(cacheRoot, targetConfig.archive)
  if (fs.existsSync(archivePath)) {
    try {
      assertFileHash(
        archivePath,
        targetConfig.sha256,
        `Cached ${targetConfig.archive}`,
      )
      return archivePath
    } catch {
      fs.rmSync(archivePath, { force: true })
    }
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/${targetConfig.archive}`
  console.log(`[stage-ripgrep] downloading ${url}`)
  await download(url, archivePath)
  assertFileHash(archivePath, targetConfig.sha256, targetConfig.archive)
  return archivePath
}

async function extractArchive(archivePath, targetConfig, destination) {
  if (targetConfig.format === 'zip') {
    await extractZip(archivePath, { dir: destination })
    return
  }
  if (targetConfig.format === 'tar.gz') {
    await tar.x({
      cwd: destination,
      file: archivePath,
      preservePaths: false,
      strict: true,
    })
    return
  }
  throw new Error(`Unsupported archive format: ${targetConfig.format}`)
}

function verifyStaged(target, { runVersion = true } = {}) {
  const targetConfig = sourceManifest.targets[target]
  const stagedManifestPath = path.join(stageRoot, 'manifest.json')
  if (!fs.existsSync(stagedManifestPath)) {
    throw new Error(`Missing staged manifest: ${stagedManifestPath}`)
  }

  const staged = JSON.parse(fs.readFileSync(stagedManifestPath, 'utf8'))
  if (staged.version !== sourceManifest.version || staged.target !== target) {
    throw new Error(
      `Staged ripgrep is ${staged.version ?? 'unknown'}/${staged.target ?? 'unknown'}, ` +
        `expected ${sourceManifest.version}/${target}`,
    )
  }
  if (staged.archiveSha256 !== targetConfig.sha256) {
    throw new Error('Staged ripgrep archive checksum metadata is stale')
  }

  const binaryPath = path.join(stageRoot, targetConfig.binary)
  if (!fs.statSync(binaryPath).isFile()) {
    throw new Error(`Missing staged ripgrep binary: ${binaryPath}`)
  }
  assertFileHash(binaryPath, staged.binarySha256, 'Staged ripgrep binary')

  for (const license of LICENSE_FILES) {
    if (!fs.statSync(path.join(stageRoot, license)).isFile()) {
      throw new Error(`Missing staged ripgrep license: ${license}`)
    }
  }

  if (target !== 'win32-x64') {
    const mode = fs.statSync(binaryPath).mode & 0o111
    if (mode === 0) {
      throw new Error(`Staged ripgrep is not executable: ${binaryPath}`)
    }
  }

  if (runVersion && target === `${process.platform}-${process.arch}`) {
    const result = spawnSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (result.status !== 0) {
      throw new Error(
        `Staged ripgrep failed to run: ${result.stderr || result.error || ''}`,
      )
    }
    const firstLine = result.stdout.trim().split(/\r?\n/, 1)[0]
    if (!firstLine.startsWith(`ripgrep ${sourceManifest.version}`)) {
      throw new Error(
        `Unexpected staged ripgrep version: ${JSON.stringify(firstLine)}`,
      )
    }
  }

  return binaryPath
}

async function stage(target) {
  const targetConfig = sourceManifest.targets[target]
  const baseUrl = process.env.RIPGREP_BASE_URL?.trim() || sourceManifest.baseUrl
  const archivePath = await ensureArchive(targetConfig, baseUrl)
  const extractRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-agent-ripgrep-'),
  )
  const stageParent = path.dirname(stageRoot)
  const temporaryStage = path.join(
    stageParent,
    `.ripgrep-${process.pid}-${Date.now()}`,
  )

  try {
    await extractArchive(archivePath, targetConfig, extractRoot)
    const archiveRoot = path.join(extractRoot, targetConfig.archiveRoot)
    const sourceBinary = path.join(archiveRoot, targetConfig.binary)
    if (!fs.existsSync(sourceBinary)) {
      throw new Error(
        `Archive did not contain expected binary: ${path.relative(
          extractRoot,
          sourceBinary,
        )}`,
      )
    }

    fs.mkdirSync(temporaryStage, { recursive: true })
    const stagedBinary = path.join(temporaryStage, targetConfig.binary)
    fs.copyFileSync(sourceBinary, stagedBinary)
    if (target !== 'win32-x64') fs.chmodSync(stagedBinary, 0o755)

    for (const license of LICENSE_FILES) {
      const sourceLicense = path.join(archiveRoot, license)
      if (!fs.existsSync(sourceLicense)) {
        throw new Error(`Archive did not contain expected license: ${license}`)
      }
      fs.copyFileSync(sourceLicense, path.join(temporaryStage, license))
    }

    const stagedManifest = {
      version: sourceManifest.version,
      target,
      source: `${sourceManifest.baseUrl}/${targetConfig.archive}`,
      archive: targetConfig.archive,
      archiveSha256: targetConfig.sha256,
      binary: targetConfig.binary,
      binarySha256: sha256File(stagedBinary),
      licenses: LICENSE_FILES,
    }
    fs.writeFileSync(
      path.join(temporaryStage, 'manifest.json'),
      `${JSON.stringify(stagedManifest, null, 2)}\n`,
    )

    fs.rmSync(stageRoot, { recursive: true, force: true })
    fs.renameSync(temporaryStage, stageRoot)
    verifyStaged(target)
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true })
    fs.rmSync(temporaryStage, { recursive: true, force: true })
  }

  console.log(
    `[stage-ripgrep] staged ripgrep ${sourceManifest.version} for ${target} -> ${stageRoot}`,
  )
}

async function main() {
  const { target, checkOnly } = parseArgs()
  if (checkOnly) {
    verifyStaged(target)
    console.log(
      `[stage-ripgrep] verified ripgrep ${sourceManifest.version} for ${target}`,
    )
    return
  }
  await stage(target)
}

module.exports = {
  LICENSE_FILES,
  assertFileHash,
  parseArgs,
  sha256File,
  sourceManifest,
  stageRoot,
  targetFor,
  verifyStaged,
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[stage-ripgrep] ${error.stack || error}`)
    process.exit(1)
  })
}

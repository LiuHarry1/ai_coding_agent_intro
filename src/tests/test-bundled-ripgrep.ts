import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolveRgCommand } from '../utils/resolve-rg-command.js'

type TargetConfig = {
  archive: string
  sha256: string
  format: 'zip' | 'tar.gz'
  archiveRoot: string
  binary: string
}

type StageModule = {
  LICENSE_FILES: string[]
  assertFileHash: (filePath: string, expected: string, label: string) => void
  parseArgs: (args: string[]) => { target: string; checkOnly: boolean }
  sha256File: (filePath: string) => string
  sourceManifest: {
    version: string
    targets: Record<string, TargetConfig>
  }
  targetFor: (platform: string, arch: string) => string
}

const require = createRequire(import.meta.url)
const staging = require('../../scripts/stage-ripgrep.cjs') as StageModule
const temp = await mkdtemp(path.join(tmpdir(), 'bundled-ripgrep-test-'))

try {
  const executable = path.join(temp, 'rg')
  await writeFile(executable, 'fixture')
  await mkdir(path.join(temp, 'directory'))

  assert.equal(
    resolveRgCommand({ BUNDLED_RG_PATH: executable }),
    executable,
    'an existing absolute bundled path must win',
  )
  assert.equal(
    resolveRgCommand({ BUNDLED_RG_PATH: `  ${executable}  ` }),
    executable,
    'the injected path may be surrounded by environment whitespace',
  )
  assert.equal(
    resolveRgCommand({ BUNDLED_RG_PATH: 'relative/rg' }),
    'rg',
    'a relative injected path must never be trusted',
  )
  assert.equal(
    resolveRgCommand({
      BUNDLED_RG_PATH: path.join(temp, 'missing-rg'),
    }),
    'rg',
    'a missing bundled binary must fall back to PATH',
  )
  assert.equal(
    resolveRgCommand({
      BUNDLED_RG_PATH: path.join(temp, 'directory'),
    }),
    'rg',
    'a directory must not be treated as an executable',
  )
  assert.equal(resolveRgCommand({}), 'rg')

  assert.equal(staging.sourceManifest.version, '15.2.0')
  assert.deepEqual(Object.keys(staging.sourceManifest.targets).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'win32-x64',
  ])
  assert.equal(staging.sourceManifest.targets['win32-x64']?.binary, 'rg.exe')
  assert.equal(staging.sourceManifest.targets['darwin-arm64']?.binary, 'rg')
  for (const config of Object.values(staging.sourceManifest.targets)) {
    assert.match(config.sha256, /^[a-f0-9]{64}$/)
  }
  assert.deepEqual(staging.LICENSE_FILES, ['LICENSE-MIT', 'UNLICENSE'])
  assert.equal(staging.targetFor('darwin', 'arm64'), 'darwin-arm64')
  assert.throws(() => staging.targetFor('linux', 'x64'), /Unsupported/)
  assert.deepEqual(staging.parseArgs(['--target', 'win32-x64', '--check']), {
    target: 'win32-x64',
    checkOnly: true,
  })
  assert.throws(() => staging.parseArgs(['--target']), /requires a value/)

  const fixtureHash = staging.sha256File(executable)
  staging.assertFileHash(executable, fixtureHash, 'fixture')
  assert.throws(
    () => staging.assertFileHash(executable, '0'.repeat(64), 'fixture'),
    /SHA-256 mismatch/,
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}

console.log('PASS bundled ripgrep resolver and staging checks')

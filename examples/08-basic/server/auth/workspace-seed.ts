/**
 * Seed a new per-user workspace from a baked-in template directory.
 *
 * Used in SSO mode: on first login the user's pinned directory is created
 * and populated from `WORKSPACE_SEED_DIR` (default `/opt/workspace-seed`).
 * Tenant images COPY their curated defaults there at build time — see
 * `deploy/workspace-seed/` and `deploy/Dockerfile.agent.example`.
 *
 * Seeding runs at most once per user workspace (`.workspace-seeded` marker).
 * Existing files are never overwritten (`errorOnExist: false`).
 */
import * as fs from 'fs'
import * as path from 'path'

export const WORKSPACE_SEEDED_MARKER = '.workspace-seeded'

const DEFAULT_SEED_DIR = '/opt/workspace-seed'

/** Resolved seed dir, or null when seeding is disabled / nothing to copy. */
export function getWorkspaceSeedDir(): string | null {
  const raw = process.env.WORKSPACE_SEED_DIR
  // Explicit empty string disables seeding even if the default path exists.
  if (raw != null && raw.trim() === '') return null

  const dir = path.resolve(raw?.trim() || DEFAULT_SEED_DIR)
  if (!fs.existsSync(dir)) return null

  try {
    if (fs.readdirSync(dir).length === 0) return null
  } catch {
    return null
  }

  return dir
}

function copyEntry(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    force: false,
    errorOnExist: false,
  })
}

/**
 * Copy everything under `seedDir` into `userWorkspace` without overwriting
 * existing paths. Returns true when at least one entry was copied.
 */
export function applyWorkspaceSeed(
  userWorkspace: string,
  seedDir: string,
): boolean {
  let copied = false
  for (const name of fs.readdirSync(seedDir)) {
    if (name === WORKSPACE_SEEDED_MARKER) continue
    copyEntry(path.join(seedDir, name), path.join(userWorkspace, name))
    copied = true
  }
  return copied
}

function writeSeedMarker(userWorkspace: string, seedDir: string): void {
  const markerPath = path.join(userWorkspace, WORKSPACE_SEEDED_MARKER)
  fs.writeFileSync(
    markerPath,
    JSON.stringify(
      {
        seededAt: new Date().toISOString(),
        seedDir,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  )
}

/**
 * On first use of a user workspace, copy the image-baked seed template.
 * Idempotent — safe to call on every authenticated request.
 */
export function seedUserWorkspaceIfNeeded(userWorkspace: string): boolean {
  const markerPath = path.join(userWorkspace, WORKSPACE_SEEDED_MARKER)
  if (fs.existsSync(markerPath)) return false

  const raw = process.env.WORKSPACE_SEED_DIR
  if (raw != null && raw.trim() === '') {
    writeSeedMarker(userWorkspace, '')
    return false
  }

  const seedDir = getWorkspaceSeedDir()
  if (!seedDir) return false

  try {
    applyWorkspaceSeed(userWorkspace, seedDir)
    writeSeedMarker(userWorkspace, seedDir)
    console.log(`[auth] seeded workspace ${userWorkspace} from ${seedDir}`)
    return true
  } catch (err) {
    console.error(
      `[auth] workspace seed failed for ${userWorkspace}: ${(err as Error).message}`,
    )
    return false
  }
}

/**
 * Project snapshot → local user-scope agent memory sync
 * (aligned with Claude Code agentMemorySnapshot.ts).
 */
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { getAppDirName } from '../../utils/app-dir.js'
import { type AgentMemoryScope, getAgentMemoryDir } from './agentMemory.js'

const SNAPSHOT_BASE = 'agent-memory-snapshots'
const SNAPSHOT_JSON = 'snapshot.json'
const SYNCED_JSON = '.snapshot-synced.json'

type SnapshotMeta = { updatedAt: string }
type SyncedMeta = { syncedFrom: string }

export function getSnapshotDirForAgent(agentType: string, cwd: string): string {
  return join(cwd, getAppDirName(), SNAPSHOT_BASE, agentType)
}

function getSnapshotJsonPath(agentType: string, cwd: string): string {
  return join(getSnapshotDirForAgent(agentType, cwd), SNAPSHOT_JSON)
}

function getSyncedJsonPath(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
): string {
  return join(getAgentMemoryDir(agentType, scope, cwd), SYNCED_JSON)
}

async function readJsonFile<T extends object>(
  path: string,
): Promise<T | null> {
  try {
    const content = await readFile(path, { encoding: 'utf-8' })
    const parsed = JSON.parse(content) as T
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

async function copySnapshotToLocal(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
): Promise<void> {
  const snapshotMemDir = getSnapshotDirForAgent(agentType, cwd)
  const localMemDir = getAgentMemoryDir(agentType, scope, cwd)

  await mkdir(localMemDir, { recursive: true })

  try {
    const files = await readdir(snapshotMemDir, { withFileTypes: true })
    for (const dirent of files) {
      if (!dirent.isFile() || dirent.name === SNAPSHOT_JSON) continue
      const content = await readFile(join(snapshotMemDir, dirent.name), {
        encoding: 'utf-8',
      })
      await writeFile(join(localMemDir, dirent.name), content)
    }
  } catch (e) {
    console.warn(
      `[agent-memory] Failed to copy snapshot to local for ${agentType}: ${e}`,
    )
  }
}

async function saveSyncedMeta(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
  snapshotTimestamp: string,
): Promise<void> {
  const syncedPath = getSyncedJsonPath(agentType, scope, cwd)
  const localMemDir = getAgentMemoryDir(agentType, scope, cwd)
  await mkdir(localMemDir, { recursive: true })
  const meta: SyncedMeta = { syncedFrom: snapshotTimestamp }
  try {
    await writeFile(syncedPath, JSON.stringify(meta))
  } catch (e) {
    console.warn(
      `[agent-memory] Failed to save snapshot sync metadata for ${agentType}: ${e}`,
    )
  }
}

/**
 * Check if a snapshot exists and whether it's newer than what we last synced.
 */
export async function checkAgentMemorySnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
): Promise<{
  action: 'none' | 'initialize' | 'prompt-update'
  snapshotTimestamp?: string
}> {
  const snapshotMeta = await readJsonFile<SnapshotMeta>(
    getSnapshotJsonPath(agentType, cwd),
  )

  if (!snapshotMeta?.updatedAt) {
    return { action: 'none' }
  }

  const localMemDir = getAgentMemoryDir(agentType, scope, cwd)

  let hasLocalMemory = false
  try {
    const dirents = await readdir(localMemDir, { withFileTypes: true })
    hasLocalMemory = dirents.some(d => d.isFile() && d.name.endsWith('.md'))
  } catch {
    // Directory doesn't exist
  }

  if (!hasLocalMemory) {
    return { action: 'initialize', snapshotTimestamp: snapshotMeta.updatedAt }
  }

  const syncedMeta = await readJsonFile<SyncedMeta>(
    getSyncedJsonPath(agentType, scope, cwd),
  )

  if (
    !syncedMeta?.syncedFrom ||
    new Date(snapshotMeta.updatedAt) > new Date(syncedMeta.syncedFrom)
  ) {
    return {
      action: 'prompt-update',
      snapshotTimestamp: snapshotMeta.updatedAt,
    }
  }

  return { action: 'none' }
}

export async function initializeFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
  snapshotTimestamp: string,
): Promise<void> {
  await copySnapshotToLocal(agentType, scope, cwd)
  await saveSyncedMeta(agentType, scope, cwd, snapshotTimestamp)
}

export async function replaceFromSnapshot(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
  snapshotTimestamp: string,
): Promise<void> {
  const localMemDir = getAgentMemoryDir(agentType, scope, cwd)
  try {
    const existing = await readdir(localMemDir, { withFileTypes: true })
    for (const dirent of existing) {
      if (dirent.isFile() && dirent.name.endsWith('.md')) {
        await unlink(join(localMemDir, dirent.name))
      }
    }
  } catch {
    // Directory may not exist yet
  }
  await copySnapshotToLocal(agentType, scope, cwd)
  await saveSyncedMeta(agentType, scope, cwd, snapshotTimestamp)
}

export async function markSnapshotSynced(
  agentType: string,
  scope: AgentMemoryScope,
  cwd: string,
  snapshotTimestamp: string,
): Promise<void> {
  await saveSyncedMeta(agentType, scope, cwd, snapshotTimestamp)
}

/**
 * For subagents with memory:user, copy project snapshot on first use;
 * mark pendingSnapshotUpdate when a newer snapshot exists (no UI dialog).
 */
export async function initializeAgentMemorySnapshots(
  agents: Array<{
    agentType: string
    memory?: AgentMemoryScope
    pendingSnapshotUpdate?: { snapshotTimestamp: string }
  }>,
  cwd: string,
): Promise<void> {
  await Promise.all(
    agents.map(async agent => {
      if (agent.memory !== 'user') return
      const result = await checkAgentMemorySnapshot(
        agent.agentType,
        agent.memory,
        cwd,
      )
      switch (result.action) {
        case 'initialize':
          await initializeFromSnapshot(
            agent.agentType,
            agent.memory,
            cwd,
            result.snapshotTimestamp!,
          )
          break
        case 'prompt-update':
          agent.pendingSnapshotUpdate = {
            snapshotTimestamp: result.snapshotTimestamp!,
          }
          console.warn(
            `[agent-memory] Newer snapshot available for ${agent.agentType} (snapshot: ${result.snapshotTimestamp})`,
          )
          break
      }
    }),
  )
}

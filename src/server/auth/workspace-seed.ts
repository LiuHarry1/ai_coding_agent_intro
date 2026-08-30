/**
 * Re-export workspace seeding for SSO auth callers.
 * Implementation lives in src/core/workspace-seed.ts.
 */
export {
  WORKSPACE_SEEDED_MARKER,
  getWorkspaceSeedDir,
  applyWorkspaceSeed,
  seedUserWorkspaceIfNeeded,
} from '../../core/workspace-seed.js'

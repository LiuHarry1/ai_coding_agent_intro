/**
 * HTTP-facing session helpers. Persistence lives in `src/session/`;
 * access control stays here because it depends on server auth.
 */
import type { Session } from '../core/types.js'
import { isAuthEnabled, isSuperRole } from './auth/identity.js'

export {
  SESSION_DIR,
  getToolResultFilePath,
  tryBeginTurn,
  endTurn,
  createSession,
  getSession,
  setSessionTitle,
  listSessions,
  deleteSession,
  appendMessage,
  appendCompaction,
  appendModeChange,
  appendAgentChange,
} from '../session/index.js'

/**
 * Whether `requesterEmail` may read/modify `session`.
 *
 * - Auth off (legacy / local / password mode): always true.
 * - Auth on: the requester must match the session's recorded owner, unless
 *   their JWT role is `super` (may read any session). Sessions with no owner
 *   are denied to non-super users so UUID guessing cannot leak history.
 */
export function canAccessSession(
  session: Session,
  requesterEmail: string | undefined,
  requesterRole?: string,
): boolean {
  if (!isAuthEnabled()) return true
  if (isSuperRole(requesterRole)) return true
  return Boolean(requesterEmail) && session.ownerEmail === requesterEmail
}

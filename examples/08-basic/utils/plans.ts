/**
 * Plan file management. Plans live under {workspace}/.ai-agent/plans/{slug}.md
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import type { Session } from '../core/types.js'

const PLANS_SUBDIR = '.ai-agent/plans'

const ADJECTIVES = [
  'brave',
  'calm',
  'clever',
  'eager',
  'gentle',
  'happy',
  'keen',
  'lucky',
  'nimble',
  'proud',
  'quick',
  'sharp',
  'steady',
  'swift',
  'witty',
] as const

const NOUNS = [
  'badger',
  'beacon',
  'cedar',
  'comet',
  'falcon',
  'harbor',
  'maple',
  'meadow',
  'otter',
  'panda',
  'river',
  'sparrow',
  'tiger',
  'willow',
] as const

function pick<T extends readonly string[]>(arr: T): string {
  return arr[randomBytes(1)[0]! % arr.length]!
}

function generateWordSlug(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`
}

export function getPlansDirectory(cwd: string): string {
  const dir = path.join(cwd, PLANS_SUBDIR)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function ensurePlanSlug(session: Session, cwd: string): string {
  if (session.permissionMode.planSlug) {
    return session.permissionMode.planSlug
  }

  const plansDir = getPlansDirectory(cwd)
  let slug = generateWordSlug()
  let attempts = 0
  while (fs.existsSync(path.join(plansDir, `${slug}.md`)) && attempts < 10) {
    slug = generateWordSlug()
    attempts++
  }

  session.permissionMode = {
    ...session.permissionMode,
    planSlug: slug,
  }
  return slug
}

export function getPlanFilePath(session: Session, cwd: string): string {
  const slug = ensurePlanSlug(session, cwd)
  return path.join(getPlansDirectory(cwd), `${slug}.md`)
}

export function isSessionPlanFile(
  absolutePath: string,
  session: Session,
  cwd: string,
): boolean {
  if (!session.permissionMode.planSlug) return false
  const expected = path.resolve(getPlanFilePath(session, cwd))
  const normalized = path.resolve(absolutePath)
  return normalized === expected && normalized.endsWith('.md')
}

export function getPlan(session: Session, cwd: string): string | null {
  const filePath = getPlanFilePath(session, cwd)
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export function planExists(session: Session, cwd: string): boolean {
  return getPlan(session, cwd) !== null
}

export function writePlan(
  session: Session,
  cwd: string,
  content: string,
): string {
  const filePath = getPlanFilePath(session, cwd)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

export function clearPlanSlug(session: Session): void {
  session.permissionMode = { ...session.permissionMode, planSlug: undefined }
}

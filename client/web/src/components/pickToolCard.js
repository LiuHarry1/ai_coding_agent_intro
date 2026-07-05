import ToolCallCard from './ToolCallCard.jsx'
import FileChangeCard from './FileChangeCard.jsx'
import ReadFileCard from './ReadFileCard.jsx'
import ListDirCard from './ListDirCard.jsx'
import BashCard from './BashCard.jsx'
import WebSearchCard from './WebSearchCard.jsx'
import WebFetchCard from './WebFetchCard.jsx'
import SubagentCard from './SubagentCard.jsx'
import GlobCard from './GlobCard.jsx'
import GrepCard from './GrepCard.jsx'
import ToolSearchCard from './ToolSearchCard.jsx'
import SkillCard from './SkillCard.jsx'
import SubagentStepFallback from './SubagentStepFallback.jsx'
import { isFetchTool, isSearchTool } from '../lib/tool-kind.js'
import {
  BASH,
  POWERSHELL,
  READ,
  WRITE,
  EDIT,
  LIST_DIR,
  WEB_SEARCH,
  WEB_FETCH,
  GLOB,
  GREP,
  TOOL_SEARCH,
  SKILL,
  SUPPRESSED_TOOL_CARDS,
  SUBAGENT_SUPPRESSED,
} from '../lib/tool-names.js'

export { SUPPRESSED_TOOL_CARDS, SUBAGENT_SUPPRESSED }

const TOOL_CARDS = {
  [WRITE]: FileChangeCard,
  [EDIT]: FileChangeCard,
  [READ]: ReadFileCard,
  [LIST_DIR]: ListDirCard,
  [BASH]: BashCard,
  [POWERSHELL]: BashCard,
  [WEB_SEARCH]: WebSearchCard,
  [WEB_FETCH]: WebFetchCard,
  [GLOB]: GlobCard,
  [GREP]: GrepCard,
  [TOOL_SEARCH]: ToolSearchCard,
  [SKILL]: SkillCard,
}

export function pickCard(item, options = {}) {
  const { nested = false } = options
  // Skills always render via SkillCard — unified
  // skill renderer where the headline (skill name) comes straight from the
  // tool input, so it's stable from the first frame (no inline/fork component
  // swap). SkillCard itself shows fork nested-steps inline when present.
  // This check must come BEFORE `isSubagent` (skills are flagged subagent
  // server-side only so fork nested-step events route in the store).
  if (item.name === SKILL) return SkillCard
  if (item.isSubagent) return SubagentCard
  const name = item.name
  if (TOOL_CARDS[name]) return TOOL_CARDS[name]
  if (isFetchTool(name)) return WebFetchCard
  if (isSearchTool(name)) return WebSearchCard
  if (nested) return SubagentStepFallback
  return ToolCallCard
}

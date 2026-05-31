import ToolCallCard from "./ToolCallCard.jsx";
import FileChangeCard from "./FileChangeCard.jsx";
import ReadFileCard from "./ReadFileCard.jsx";
import ListDirCard from "./ListDirCard.jsx";
import BashCard from "./BashCard.jsx";
import WebSearchCard from "./WebSearchCard.jsx";
import WebFetchCard from "./WebFetchCard.jsx";
import SubagentCard from "./SubagentCard.jsx";
import GlobCard from "./GlobCard.jsx";
import GrepCard from "./GrepCard.jsx";
import ToolSearchCard from "./ToolSearchCard.jsx";
import { isFetchTool, isSearchTool } from "../lib/tool-kind.js";
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
  SUPPRESSED_TOOL_CARDS,
} from "../lib/tool-names.js";

export { SUPPRESSED_TOOL_CARDS };

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
};

export function pickCard(item) {
  if (item.isSubagent) return SubagentCard;
  const name = item.name;
  if (TOOL_CARDS[name]) return TOOL_CARDS[name];
  if (isFetchTool(name)) return WebFetchCard;
  if (isSearchTool(name)) return WebSearchCard;
  return ToolCallCard;
}

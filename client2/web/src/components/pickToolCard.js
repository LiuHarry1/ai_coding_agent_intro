import ToolCallCard from "./ToolCallCard.jsx";
import FileChangeCard from "./FileChangeCard.jsx";
import ReadFileCard from "./ReadFileCard.jsx";
import ListDirCard from "./ListDirCard.jsx";
import BashCard from "./BashCard.jsx";
import WebSearchCard from "./WebSearchCard.jsx";
import SubagentCard from "./SubagentCard.jsx";

// Tool-name → dedicated card component. Subagent dispatch is handled
// separately because `isSubagent` is a flag rather than a fixed name —
// any registered subagent (explore, plan, custom) routes to SubagentCard
// regardless of its tool name.
const TOOL_CARDS = {
  write_file: FileChangeCard,
  edit_file: FileChangeCard,
  read_file: ReadFileCard,
  list_dir: ListDirCard,
  bash: BashCard,
  powershell: BashCard,
  web_search: WebSearchCard,
};

// Tools that render via a non-tool-card path elsewhere (e.g. TodoListCard
// from the `todo_list` part type). Drop the duplicate tool_call row.
export const SUPPRESSED_TOOL_CARDS = new Set(["todo_write"]);

export function pickCard(item) {
  if (item.isSubagent) return SubagentCard;
  return TOOL_CARDS[item.name] || ToolCallCard;
}

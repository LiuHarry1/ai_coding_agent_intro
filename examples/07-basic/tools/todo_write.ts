import { tool } from "ai";
import { z } from "zod";
import type { ToolDefinition, TodoItem, TodoStatus } from "../core/types.js";

const STATUS_ORDER: Record<TodoStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
};

function sortTodos(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}

function summarize(items: TodoItem[]): string {
  const counts: Record<string, number> = {};
  for (const t of items) counts[t.status] = (counts[t.status] || 0) + 1;

  const parts: string[] = [];
  for (const s of ["in_progress", "pending", "completed", "cancelled"] as TodoStatus[]) {
    if (counts[s]) parts.push(`${counts[s]} ${s}`);
  }
  return `Updated ${items.length} todos: ${parts.join(", ")}`;
}

export const definition: ToolDefinition = {
  name: "todo_write",
  description: "Create or update a structured task checklist to track multi-step work",

  create(_cwd, context) {
    const todos = new Map<string, TodoItem>();

    return tool({
      description:
        "Create or update a structured todo list for tracking multi-step tasks. " +
        "Use for complex work (3+ steps). Set merge=true to update existing items by id " +
        "without replacing the full list. Keep only ONE item in_progress at a time. " +
        "Mark items completed as you finish them.",
      inputSchema: z.object({
        todos: z
          .array(
            z.object({
              id: z.string().describe("Unique identifier, e.g. 'setup-db', 'add-auth'"),
              content: z.string().describe("Short description of the task"),
              status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
            })
          )
          .min(1),
        merge: z
          .boolean()
          .optional()
          .default(false)
          .describe("true = upsert by id; false = replace entire list"),
      }),
      execute: async ({
        todos: incoming,
        merge,
      }: {
        todos: Array<{ id: string; content: string; status: TodoStatus }>;
        merge: boolean;
      }) => {
        if (!merge) {
          todos.clear();
        }

        for (const item of incoming) {
          const existing = todos.get(item.id);
          todos.set(item.id, {
            id: item.id,
            content: item.content ?? existing?.content ?? "",
            status: item.status ?? existing?.status ?? "pending",
          });
        }

        const sorted = sortTodos([...todos.values()]);

        context.eventBus.emit("todo_update", { todos: sorted });

        return summarize(sorted);
      },
    });
  },
};

import { tool } from "ai";
import { z } from "zod";
import { truncate } from "./utils.js";
import type { ToolDefinition } from "../core/types.js";
import { WEB_SEARCH_TOOL_NAME } from "../constants/tool_names.js";
import {
  executeWebSearch,
  getWebSearchProvider,
  webSearchProviderLabel,
  type WebSearchPayload,
} from "./web-search/index.js";

const MAX_RESULTS = 10;
const MAX_OUTPUT_CHARS = 12000;

const EMPTY_RESULTS_WARNING =
  "Search returned zero results. Do NOT invent news, events, or facts. " +
  "Tell the user the search found nothing and suggest retrying with a simpler query " +
  "or switching WEB_SEARCH_PROVIDER (exa vs searxng).";

function formatWebSearchOutput(output: WebSearchPayload): string {
  const payload: WebSearchPayload & { warning?: string } = { ...output };
  if (payload.results.length === 0 && !payload.content) {
    payload.warning = EMPTY_RESULTS_WARNING;
  }
  return truncate(JSON.stringify(payload, null, 2), MAX_OUTPUT_CHARS);
}

function asPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_RESULTS, Math.floor(value!)));
}

function providerDescription(): string {
  const provider = getWebSearchProvider();
  if (provider === "exa") {
    return (
      "Search the web for current or external information using Exa AI (MCP). " +
      "Use this when project files are insufficient, information may be recent, or online references are needed. " +
      "Returns compact JSON with titles, URLs, snippets, or LLM-oriented context text."
    );
  }
  return (
    "Search the web for current or external information using SearXNG. " +
    "Use this when project files are insufficient, information may be recent, or online references are needed. " +
    "Returns compact JSON with titles, URLs, snippets, engines, and optional suggestions."
  );
}

export const definition: ToolDefinition = {
  name: WEB_SEARCH_TOOL_NAME,
  description: `Search the web (${getWebSearchProvider()})`,
  shouldDefer: true,
  isConcurrencySafe: () => true,
  create() {
    return tool({
      description: providerDescription(),
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query"),
        max_results: z.number().int().min(1).max(MAX_RESULTS).optional()
          .describe("Maximum number of results to return. Default 5, max 10."),
        language: z.string().optional()
          .describe("Optional SearXNG language code, e.g. 'en', 'zh-CN' (SearXNG only)."),
        categories: z.string().optional()
          .describe("Optional SearXNG categories, e.g. 'general', 'it', 'science' (SearXNG only)."),
        time_range: z.enum(["day", "week", "month", "year"]).optional()
          .describe("Optional time range filter (SearXNG only)."),
      }),
      execute: async (args: {
        query: string;
        max_results?: number;
        language?: string;
        categories?: string;
        time_range?: "day" | "week" | "month" | "year";
      }) => {
        const maxResults = asPositiveInt(args.max_results, 5);
        const output = await executeWebSearch(args, maxResults);

        if (typeof output === "string") {
          return output;
        }

        return formatWebSearchOutput(output);
      },
    });
  },
};

export { getWebSearchProvider, webSearchProviderLabel };

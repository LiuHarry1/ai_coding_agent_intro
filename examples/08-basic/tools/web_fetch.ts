import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { tool } from "ai";
import { z } from "zod";
import { truncate } from "./utils.js";
import { fetchWithTimeout, stripHtml } from "./http-utils.js";
import type { ToolDefinition } from "../core/types.js";
import { WEB_FETCH_TOOL_NAME } from "../constants/tool_names.js";

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_OUTPUT_CHARS = 20000;

function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }
  return url.toString();
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export const definition: ToolDefinition = {
  name: WEB_FETCH_TOOL_NAME,
  description: "Fetch a web page and extract readable article content",
  shouldDefer: true,
  isConcurrencySafe: () => true,
  create() {
    return tool({
      description:
        "Fetch a web page and extract readable article content using @mozilla/readability with linkedom. " +
        "Use this when you need the main content of a URL found by web_search or provided by the user. " +
        "Returns compact JSON with title, byline, excerpt, siteName, plain text, and metadata.",
      inputSchema: z.object({
        url: z.string().url().describe("HTTP/HTTPS URL to fetch"),
        max_chars: z.number().int().min(1000).max(MAX_OUTPUT_CHARS).optional()
          .describe("Maximum output characters. Default 12000, max 20000."),
      }),
      execute: async (args: { url: string; max_chars?: number }) => {
        let url: string;
        try {
          url = normalizeUrl(args.url);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return `Error: invalid URL: ${message}`;
        }

        try {
          const res = await fetchWithTimeout({
            url,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            headers: {
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
          });

          if (!res.ok) {
            return `Error: web fetch failed: HTTP ${res.status}. URL: ${url}`;
          }

          if (res.contentType && !/text\/html|application\/xhtml\+xml|application\/xml|text\/xml/i.test(res.contentType)) {
            return truncate(JSON.stringify({
              url,
              status: res.status,
              contentType: res.contentType,
              note: "Non-HTML content; returning raw text preview.",
              text: compactText(stripHtml(res.text)),
            }, null, 2), args.max_chars ?? 12000);
          }

          const { document } = parseHTML(res.text);
          const article = new Readability(document).parse();

          if (!article) {
            return truncate(JSON.stringify({
              url,
              status: res.status,
              contentType: res.contentType,
              note: "Readability could not extract article content; returning page text preview.",
              text: compactText(document.body?.textContent || stripHtml(res.text)),
            }, null, 2), args.max_chars ?? 12000);
          }

          const text = article.textContent
            ? compactText(article.textContent)
            : compactText(stripHtml(article.content || ""));

          return truncate(JSON.stringify({
            url,
            status: res.status,
            contentType: res.contentType,
            title: article.title || "",
            byline: article.byline || undefined,
            excerpt: article.excerpt || undefined,
            siteName: article.siteName || undefined,
            length: article.length,
            text,
          }, null, 2), args.max_chars ?? 12000);
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            return `Error: web fetch timed out after ${DEFAULT_TIMEOUT_MS}ms. URL: ${url}`;
          }
          const message = err instanceof Error ? err.message : String(err);
          return `Error: web fetch failed: ${message}. URL: ${url}`;
        }
      },
    });
  },
};

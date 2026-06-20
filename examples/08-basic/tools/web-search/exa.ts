import type { WebSearchArgs, WebSearchHit, WebSearchPayload } from "./searxng.js";

const EXA_URL = process.env.EXA_API_KEY
  ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(process.env.EXA_API_KEY)}`
  : "https://mcp.exa.ai/mcp";
const EXA_TIMEOUT_MS = 25000;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; ai-coding-agent/1.0)";

interface McpContentBlock {
  type?: string;
  text?: string;
}

interface McpResult {
  result?: {
    content?: McpContentBlock[];
  };
}

function parseMcpPayload(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const data = JSON.parse(trimmed) as McpResult;
    const text = data.result?.content?.find((item) => item.text)?.text;
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

function parseMcpResponse(body: string): string | undefined {
  const direct = parseMcpPayload(body.trim());
  if (direct) return direct;

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = parseMcpPayload(line.slice(6));
    if (data) return data;
  }
  return undefined;
}

function compactSnippet(value: string, maxLen = 500): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

/** Exa MCP returns `Title:` / `URL:` blocks separated by `---`. */
function parseExaTextToResults(text: string, maxResults: number): WebSearchHit[] {
  const results: WebSearchHit[] = [];
  const seen = new Set<string>();

  for (const block of text.split(/\n---\n/)) {
    const urlMatch = block.match(/^URL:\s*(\S+)/m);
    if (!urlMatch) continue;
    const url = urlMatch[1].trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const titleMatch = block.match(/^Title:\s*(.+)$/m);
    const publishedMatch = block.match(/^Published:\s*(.+)$/m);
    const highlightsMatch = block.match(/^Highlights:\n([\s\S]*)/m);
    const snippet = highlightsMatch?.[1]
      ? compactSnippet(highlightsMatch[1])
      : publishedMatch?.[1]?.trim() || "";

    results.push({
      rank: results.length + 1,
      title: titleMatch?.[1]?.trim() || url,
      url,
      snippet,
      publishedDate: publishedMatch?.[1]?.trim(),
    });
    if (results.length >= maxResults) break;
  }

  return results;
}

function parseMarkdownLinks(text: string, maxResults: number): WebSearchHit[] {
  const results: WebSearchHit[] = [];
  const seen = new Set<string>();
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

  for (const match of text.matchAll(linkRegex)) {
    const title = match[1]?.trim() || "";
    const url = match[2]?.trim() || "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      rank: results.length + 1,
      title,
      url,
      snippet: "",
    });
    if (results.length >= maxResults) break;
  }

  return results;
}

function parseExaResults(text: string, maxResults: number): WebSearchHit[] {
  const fromExaBlocks = parseExaTextToResults(text, maxResults);
  if (fromExaBlocks.length > 0) return fromExaBlocks;
  return parseMarkdownLinks(text, maxResults);
}

export async function searchWithExa(
  args: WebSearchArgs,
  maxResults: number,
): Promise<WebSearchPayload | string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXA_TIMEOUT_MS);

  try {
    const response = await fetch(EXA_URL, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: args.query,
            type: "auto",
            numResults: maxResults,
            livecrawl: "fallback",
          },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return `Error: Exa search failed: HTTP ${response.status}. URL: ${EXA_URL}`;
    }

    const text = await response.text();
    const content = parseMcpResponse(text);
    if (!content) {
      return `Error: Exa search returned no parseable MCP content. URL: ${EXA_URL}`;
    }

    const results = parseExaResults(content, maxResults);

    return {
      query: args.query,
      provider: "exa",
      source: EXA_URL.replace(/\?.*$/, ""),
      format: results.length > 0 ? "exa-mcp" : "mcp-text",
      results,
      content: results.length === 0 ? content : undefined,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return `Error: Exa search timed out after ${EXA_TIMEOUT_MS}ms. URL: ${EXA_URL}`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Error: Exa search failed: ${message}. URL: ${EXA_URL}`;
  } finally {
    clearTimeout(timeout);
  }
}

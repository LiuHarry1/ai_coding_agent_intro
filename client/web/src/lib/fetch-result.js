/**
 * Normalize fetch tool results from:
 * - built-in web_fetch (JSON with title, text, …)
 * - MCP fetch / mcp_server_fetch (markdown text or content-block JSON)
 */

function extractMarkdownTitle(text) {
  if (typeof text !== "string") return "";
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "";
}

function stripMcpContentsPrefix(text, url) {
  if (typeof text !== "string") return text;
  if (url) {
    const exact = `Contents of ${url}:\n`;
    if (text.startsWith(exact)) return text.slice(exact.length);
  }
  const m = text.match(/^Contents of (https?:\/\/\S+):\n([\s\S]*)$/);
  if (m) return { text: m[2], url: m[1] };
  return text;
}

function textFromContentBlocks(value) {
  if (Array.isArray(value)) {
    return value
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.content)) return textFromContentBlocks(value.content);
    if (typeof value.text === "string") return value.text;
  }
  return "";
}

/**
 * @returns {{ text: string, title: string, excerpt?: string, url?: string, note?: string, error?: string }}
 */
export function normalizeFetchResult(result, requestUrl) {
  const empty = { text: "", title: "", url: requestUrl || undefined };

  if (result == null) return empty;
  if (typeof result !== "string") {
    const text = textFromContentBlocks(result);
    return normalizeFetchResult(text || JSON.stringify(result), requestUrl);
  }

  if (result.startsWith("Error:")) {
    return { ...empty, error: result };
  }
  if (/^Failed to fetch\b/i.test(result)) {
    return { ...empty, error: result };
  }

  // MCP / SDK may JSON-serialize content blocks
  if (result.startsWith("[") || (result.startsWith("{") && result.includes('"type"'))) {
    try {
      const parsed = JSON.parse(result);
      const blockText = textFromContentBlocks(parsed);
      if (blockText) return normalizeFetchResult(blockText, requestUrl);
      if (parsed && typeof parsed.text === "string") {
        return {
          text: parsed.text,
          title: parsed.title || "",
          excerpt: parsed.excerpt,
          url: parsed.url || requestUrl,
          note: parsed.note,
        };
      }
    } catch {
      /* fall through */
    }
  }

  // Built-in web_fetch JSON
  if (result.startsWith("{")) {
    try {
      const parsed = JSON.parse(result);
      if (parsed && (parsed.text != null || parsed.url != null)) {
        return {
          text: typeof parsed.text === "string" ? parsed.text : "",
          title: parsed.title || "",
          excerpt: parsed.excerpt,
          url: parsed.url || requestUrl,
          note: parsed.note,
        };
      }
    } catch {
      const lastBrace = result.lastIndexOf('"}');
      if (lastBrace > 0) {
        try {
          const parsed = JSON.parse(result.slice(0, lastBrace + 2) + "\n}");
          if (parsed?.text != null) {
            return {
              text: parsed.text,
              title: parsed.title || "",
              excerpt: parsed.excerpt,
              url: parsed.url || requestUrl,
              note: parsed.note,
            };
          }
        } catch {
          /* fall through */
        }
      }
    }
  }

  // MCP fetch plain text: "Contents of https://…:\n# Title\n…"
  const stripped = stripMcpContentsPrefix(result, requestUrl);
  if (stripped && typeof stripped === "object") {
    return {
      text: stripped.text,
      title: extractMarkdownTitle(stripped.text),
      url: stripped.url || requestUrl,
    };
  }

  const text = typeof stripped === "string" ? stripped : result;
  return {
    text,
    title: extractMarkdownTitle(text),
    url: requestUrl,
  };
}

/** Shorten fetch errors when the URL is already shown in the header. */
export function compactFetchError(message, url) {
  if (typeof message !== "string") return message;
  let msg = message;
  if (url) {
    for (const suffix of [`. URL: ${url}`, ` ${url}`, `: ${url}`]) {
      if (msg.endsWith(suffix)) msg = msg.slice(0, -suffix.length);
    }
  }
  return msg.replace(/^Error:\s*/, "");
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; ai-coding-agent/1.0)";

export function cleanURL(value: string): string {
  return value.replace(/\/+$/, "");
}

export function decodeHtml(value: string): string {
  const entities: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => entities[name] ?? match);
}

export function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export interface FetchOptions {
  url: string | URL;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
  contentType: string;
}

export async function fetchWithTimeout(opts: FetchOptions): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(opts.url, {
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        ...opts.headers,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      text,
      contentType: res.headers.get("content-type") || "",
    };
  } finally {
    clearTimeout(timeout);
  }
}

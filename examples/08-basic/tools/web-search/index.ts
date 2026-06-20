import { getWebSearchProvider } from "./config.js";
import { searchWithExa } from "./exa.js";
import { searchWithSearXNG, type WebSearchArgs } from "./searxng.js";

export type { WebSearchArgs, WebSearchPayload } from "./searxng.js";
export { getWebSearchProvider, webSearchProviderLabel } from "./config.js";

export async function executeWebSearch(args: WebSearchArgs, maxResults: number) {
  const provider = getWebSearchProvider();
  if (provider === "exa") {
    return searchWithExa(args, maxResults);
  }
  return searchWithSearXNG(args, maxResults);
}

import type { ServerResponse } from "http";
import type { IEventBus, SSETransport } from "../core/types.js";

export function createSSETransport(
  res: ServerResponse,
  eventBus: IEventBus,
  extraHeaders: Record<string, string> = {}
): SSETransport {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...extraHeaders,
  });

  const unsubscribe = eventBus.on("*", (data: unknown, event: string) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });

  res.on("close", () => {
    unsubscribe();
  });

  return {
    send(event: string, data: unknown) {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() {
      unsubscribe();
      if (!res.writableEnded) res.end();
    },
  };
}

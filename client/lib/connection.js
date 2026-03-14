/**
 * HTTP + SSE connection to the agent server.
 *
 * chat() sends a POST /chat and streams back SSE events:
 *   thinking, tool_call, tool_result, text_delta, done, error
 */
export function createConnection(baseURL = "http://localhost:4567") {
  let eventHandler = null;
  let abortController = null;

  async function connect() {
    const res = await fetch(`${baseURL}/health`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
  }

  function onEvent(handler) {
    eventHandler = handler;
  }

  function emit(event) {
    if (eventHandler) eventHandler(event);
  }

  async function chat(message, { mode = "basic", projectDir } = {}) {
    abortController = new AbortController();

    const body = { message, mode };
    if (projectDir) body.projectDir = projectDir;

    let res;
    try {
      res = await fetch(`${baseURL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } catch (err) {
      emit({ type: "error", message: err.message });
      return;
    }

    if (!res.ok) {
      const text = await res.text();
      emit({ type: "error", message: `HTTP ${res.status}: ${text}` });
      return;
    }

    await parseSSEStream(res.body, emit);
  }

  function abort() {
    if (abortController) abortController.abort();
  }

  return { connect, onEvent, chat, abort };
}

async function parseSSEStream(body, emit) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop();

    for (const part of parts) {
      let eventType = "message";
      let dataStr = "";

      for (const line of part.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7);
        } else if (line.startsWith("data: ")) {
          dataStr += line.slice(6);
        }
      }

      if (!dataStr) continue;

      try {
        const data = JSON.parse(dataStr);
        emit({ type: eventType, ...data });
      } catch { /* skip malformed */ }
    }
  }
}

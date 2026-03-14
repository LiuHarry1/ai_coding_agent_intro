import WebSocket from "ws";

export function createConnection(url = "ws://localhost:4567") {
  let ws = null;
  let eventHandler = null;
  let reconnecting = false;

  function connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url);

      ws.on("open", () => resolve());

      ws.on("message", (raw) => {
        try {
          const event = JSON.parse(raw.toString());
          if (eventHandler) eventHandler(event);
        } catch { /* ignore malformed */ }
      });

      ws.on("close", () => {
        if (eventHandler) eventHandler({ type: "disconnected" });
      });

      ws.on("error", (err) => {
        reject(err);
      });
    });
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function chat(message) {
    send({ type: "chat", message });
  }

  function configure({ mode, projectDir } = {}) {
    send({ type: "config", mode, projectDir });
  }

  function onEvent(handler) {
    eventHandler = handler;
  }

  function disconnect() {
    if (ws) ws.close();
  }

  return { connect, send, chat, configure, onEvent, disconnect };
}

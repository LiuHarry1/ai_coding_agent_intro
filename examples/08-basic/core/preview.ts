import * as net from "node:net";

const DEFAULT_BLOCKED_PORTS = [4567];
const DEFAULT_MIN_PORT = 3000;
const DEFAULT_MAX_PORT = 9999;

function parsePortBound(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function blockedPorts(): ReadonlySet<number> {
  const extra = (process.env.PREVIEW_BLOCKED_PORTS ?? "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return new Set([...DEFAULT_BLOCKED_PORTS, ...extra]);
}

/** True only when cloud preview is configured (PREVIEW_ENABLED + PUBLIC_BASE_URL). */
export function isPreviewEnabled(): boolean {
  return process.env.PREVIEW_ENABLED === "1" && !!process.env.PUBLIC_BASE_URL?.trim();
}

export function previewPortMin(): number {
  return parsePortBound(process.env.PREVIEW_PORT_MIN, DEFAULT_MIN_PORT);
}

export function previewPortMax(): number {
  return parsePortBound(process.env.PREVIEW_PORT_MAX, DEFAULT_MAX_PORT);
}

export function previewPathPrefix(): string {
  const raw = process.env.PREVIEW_PATH_PREFIX?.trim() || "/preview";
  return raw.replace(/\/$/, "") || "/preview";
}

/** Returns an error message, or null when the port is allowed. */
export function validatePreviewPort(port: number): string | null {
  if (!Number.isInteger(port)) return "Port must be an integer";
  const min = previewPortMin();
  const max = previewPortMax();
  if (port < min || port > max) return `Port must be between ${min} and ${max}`;
  if (blockedPorts().has(port)) return `Port ${port} is reserved and cannot be previewed`;
  return null;
}

export function buildPreviewUrl(port: number, subpath = ""): string {
  const base = process.env.PUBLIC_BASE_URL!.trim().replace(/\/$/, "");
  const prefix = previewPathPrefix();
  const path = subpath
    ? subpath.startsWith("/")
      ? subpath
      : `/${subpath}`
    : "";
  return `${base}${prefix}/${port}${path}`;
}

export function probePort(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function waitForPort(port: number, waitSeconds: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  do {
    if (await probePort(port)) return true;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  } while (true);
  return probePort(port);
}

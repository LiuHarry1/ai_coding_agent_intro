import * as path from "path";
import { spawn, type ChildProcess } from "child_process";

export const isWindows = process.platform === "win32";

/** One-line platform summary for system prompts. */
export const platformLabel = `${process.platform} (${process.arch}) — shell: ${isWindows ? "PowerShell" : "bash"}`;

// ── Shell configuration ──

export interface ShellConfig {
  name: string;
  command: string;
  buildArgs(cmd: string): string[];
  spawnEnv(): NodeJS.ProcessEnv;
}

const bashShell: ShellConfig = {
  name: "bash",
  command: "bash",
  buildArgs: (cmd) => ["-c", cmd],
  spawnEnv: () => ({ ...process.env, TERM: "dumb" }),
};

const powershellShell: ShellConfig = {
  name: "PowerShell",
  command: "powershell.exe",
  buildArgs: (cmd) => ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd],
  spawnEnv: () => ({ ...process.env }),
};

export const shell: ShellConfig = isWindows ? powershellShell : bashShell;

// ── Process management ──

export function killChild(child: ChildProcess): void {
  if (isWindows) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else {
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
  }
}

export function forceKillChild(child: ChildProcess): void {
  if (isWindows) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
}

// ── Path handling ──

/** Normalize a path for case-insensitive comparison on Windows. */
export function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(p);
  return isWindows ? resolved.toLowerCase() : resolved;
}

/**
 * Normalize git output paths to OS convention.
 * Git on Windows returns forward-slash paths (C:/Users/...);
 * this converts to the OS-native format.
 */
export function normalizeGitPath(gitPath: string): string {
  return path.resolve(gitPath);
}

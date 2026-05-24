import { existsSync } from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { isWindows } from "./platform.js";

let cached: string | null | undefined;

/**
 * Locate Git for Windows bash.exe. Callers get `null` and spawn fails with a clear error.
 */
export function findGitBashPath(): string | null {
  if (!isWindows) return null;
  if (cached !== undefined) return cached;

  const defaults = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const p of defaults) {
    if (existsSync(p)) {
      cached = p;
      return cached;
    }
  }

  try {
    const r = spawnSync("where", ["git"], { encoding: "utf8", windowsHide: true });
    const gitExe = r.stdout?.trim().split(/\r?\n/)[0];
    if (gitExe) {
      const bashPath = path.join(path.dirname(gitExe), "..", "..", "bin", "bash.exe");
      if (existsSync(bashPath)) {
        cached = bashPath;
        return cached;
      }
    }
  } catch {
    // where.exe missing or git not on PATH
  }

  cached = null;
  return null;
}

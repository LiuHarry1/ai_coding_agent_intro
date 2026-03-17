#!/usr/bin/env node
/**
 * Cross-platform port killer (Windows/macOS/Linux).
 * Usage: node shared/kill-port.cjs <port>
 */

const port = Number(process.argv[2]);
if (!port || Number.isNaN(port)) {
  console.error('Usage: kill-port.cjs <port>');
  process.exit(1);
}

const isWin = process.platform === 'win32';
const { execSync } = require('node:child_process');

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    return (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
  }
}

let pids = new Set();

if (isWin) {
  const out = run(`netstat -ano -p tcp | findstr :${port}`);
  out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line) => {
      const parts = line.split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    });

  if (pids.size === 0) {
    console.log(`[kill-port] No process found on port ${port}`);
    process.exit(0);
  }

  for (const pid of pids) run(`taskkill /PID ${pid} /F`);

  console.log(`[kill-port] Killed PIDs on port ${port}: ${Array.from(pids).join(', ')}`);
  process.exit(0);
}

let out = run(`lsof -ti tcp:${port}`);
let candidate = out
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

if (candidate.length === 0) {
  out = run(`fuser -n tcp ${port} 2>/dev/null`);
  candidate = out
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

candidate.forEach((pid) => pids.add(pid));

if (pids.size === 0) {
  console.log(`[kill-port] No process found on port ${port}`);
  process.exit(0);
}

for (const pid of pids) run(`kill -9 ${pid}`);
console.log(`[kill-port] Killed PIDs on port ${port}: ${Array.from(pids).join(', ')}`);
process.exit(0);

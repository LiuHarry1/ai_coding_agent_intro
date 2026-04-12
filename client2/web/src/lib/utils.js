/**
 * Extract filename from a full file path.
 */
export function fileName(filePath) {
  if (!filePath) return null;
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1];
}

/**
 * Format a timestamp to relative time string.
 */
export function relativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Format milliseconds as human-readable duration.
 */
export function formatDuration(ms) {
  if (!ms) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

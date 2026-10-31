/** Small helpers shared by the windows. */

/** Last part of a path, for window titles. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || path;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A snapshot refresh failure in words a person can act on: a missing path
 * usually means its drive isn't plugged in.
 */
export function snapshotProblem(err: unknown): string | null {
  const message = errorMessage(err);
  if (!message.includes("no longer exists") && !message.includes("not found")) return null;
  const drive = message.match(/([A-Z]):\\/i);
  return drive ? `Drive ${drive[1]}: is not currently connected` : "Path not found - drive may be disconnected";
}

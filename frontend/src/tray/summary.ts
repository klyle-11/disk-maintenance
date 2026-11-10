/**
 * The tray panel's one line, from `di summary --json` (backend/diskcli/summary.py).
 */
import { formatBytes } from "../api";

const GB = 1 << 30;
/** Same thresholds as di's guard and summary. */
const WARN_FREE = 20 * GB;
const CRITICAL_FREE = 8 * GB;

export interface DiSummary {
  disk?: { name?: string; total?: number; free?: number } | null;
  drives?: unknown[] | null;
  free_trend?: { label: string; delta: number }[] | null;
  guard?: { installed?: boolean; loaded?: boolean | null; errored?: boolean } | null;
  big_files?: { path: string; bytes: number }[] | null;
}

export interface SummaryLine {
  text: string;
  tone: "ok" | "warn" | "bad";
}

function signed(bytes: number): string {
  return `${bytes < 0 ? "−" : "+"}${formatBytes(Math.abs(bytes))}`;
}

export function summaryLine(s: DiSummary): SummaryLine {
  const parts: string[] = [];
  let tone: SummaryLine["tone"] = "ok";
  const free = s.disk?.free;
  if (typeof free === "number") {
    if (free < CRITICAL_FREE) {
      parts.push("space critically low");
      tone = "bad";
    } else if (free < WARN_FREE) {
      parts.push("space running low");
      tone = "warn";
    }
  }
  const trend = s.free_trend?.find((t) => t.label !== "biggest drop");
  if (trend && Math.abs(trend.delta) >= 100 << 20) parts.push(`${signed(trend.delta)} free ${trend.label}`);
  const big = s.big_files?.length ?? 0;
  if (big > 0) parts.push(`${big} big new file${big === 1 ? "" : "s"} this week`);
  if (s.guard?.errored) {
    parts.push("guard reported an error");
    if (tone === "ok") tone = "warn";
  } else if (s.guard?.installed) {
    parts.push("guard on");
  }
  if (parts.length === 0) parts.push("all quiet: no big changes lately");
  return { text: parts.join(" · "), tone };
}

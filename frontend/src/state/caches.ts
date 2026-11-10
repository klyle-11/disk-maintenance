/**
 * The di window's CLEAR CACHES button: empties the OS's cache folders
 * (macOS: what the old "Clear caches.command" did; Windows: temp folders and
 * the Windows Update download cache), as an administrator, and reports what
 * it freed in the terminal. Tauri only.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { formatBytes, isTauri } from "../api";
import { ask } from "../desktop";
import { diPrint, diStore, setDiRunning } from "./di";

export interface CacheTarget {
  label: string;
  path: string;
}

interface ClearReport {
  targets: (CacheTarget & { before: number; after: number })[];
  freed: number;
  skipped: number;
}

/** The folders a clear would empty, or null when this OS (or build) has none. */
export async function getCacheTargets(): Promise<CacheTarget[] | null> {
  if (!isTauri) return null;
  try {
    const reply = await invoke<{ supported: boolean; targets: CacheTarget[] }>("cache_targets");
    return reply.supported ? reply.targets : null;
  } catch {
    return null;
  }
}

const dim = { dim: true };

export async function clearCaches(): Promise<void> {
  if (diStore.get().running) return;
  const targets = await getCacheTargets();
  if (!targets || targets.length === 0) return;
  const list = targets.map((t) => `• ${t.label}: ${t.path}`).join("\n");
  const ok = await ask(
    `Delete everything inside these folders?\n\n${list}\n\nApps rebuild their caches as they need them. You'll be asked for an administrator's permission.`,
    "Clear caches",
  );
  diPrint([
    { text: "di› ", style: { fg: "var(--lcd-accent)", bold: true } },
    { text: "clear caches", style: { bold: true } },
  ]);
  if (!ok) {
    diPrint([{ text: "not run", style: dim }]);
    return;
  }
  setDiRunning(true);
  const started = performance.now();
  try {
    const channel = new Channel<{ type: string; text?: string }>();
    channel.onmessage = (m) => {
      if (m.type === "line" && m.text) diPrint([{ text: m.text, style: dim }]);
    };
    const report = await invoke<ClearReport>("clear_caches", { onEvent: channel });
    const width = Math.max(...report.targets.map((t) => t.label.length));
    for (const t of report.targets) {
      diPrint([
        { text: `  ${t.label.padEnd(width)}  `, style: {} },
        { text: formatBytes(Math.max(0, t.before - t.after)).padStart(10), style: { fg: "var(--ansi-green)" } },
        { text: `  ${t.path}`, style: dim },
      ]);
    }
    diPrint([
      { text: "freed ", style: { bold: true } },
      { text: formatBytes(report.freed), style: { fg: "var(--ansi-green)", bold: true } },
      { text: report.skipped ? ` · ${report.skipped} item${report.skipped === 1 ? "" : "s"} in use or protected, left alone` : "", style: dim },
    ]);
    diPrint([{ text: `✓ ${((performance.now() - started) / 1000).toFixed(1)}s`, style: dim }]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "cancelled") diPrint([{ text: "cancelled: no permission given", style: { fg: "var(--ansi-yellow)" } }]);
    else diPrint([{ text: message, style: { fg: "var(--ansi-red)" } }]);
  } finally {
    setDiRunning(false);
  }
}

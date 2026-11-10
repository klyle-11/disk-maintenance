/**
 * A drop-down of folders to compare with: the folders of saved scans, the
 * folders du-hast-much is showing, and those of saved comparisons and recent
 * du-hast-much runs, plus BROWSE… for any other folder. Used wherever a
 * second folder is chosen.
 */
import { formatBytes } from "../api";
import { useApp } from "../state/app";
import { useDhm } from "../state/dhm";
import { pathKey } from "../state/scan";
import { baseName } from "./common";
import { pickDirectory } from "./pickDirectory";

const BROWSE = "\u0000browse";

interface Choice {
  path: string;
  label: string;
}

/** The folders offered, newest first, each once, leaving out `exclude`. */
function useChoices(exclude: string[]): {
  scans: Choice[];
  dhm: Choice[];
  recent: Choice[];
} {
  const snapshots = useApp((s) => s.snapshots);
  const history = useDhm((s) => s.history);
  const rows = useDhm((s) => s.results);
  const seen = new Set(exclude.filter(Boolean).map(pathKey));
  const take = (path: string | undefined): boolean => {
    if (!path) return false;
    const key = pathKey(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const list = snapshots
    .filter((s) => s && s.id)
    .sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
  const scans: Choice[] = [];
  for (const s of list) {
    if (s.snapshotType === "comparison" || !take(s.rootPath)) continue;
    scans.push({
      path: s.rootPath,
      label: `${baseName(s.rootPath)} · ${formatBytes(s.totalSizeBytes || 0)}`,
    });
  }
  const dhm: Choice[] = [];
  for (const r of rows)
    if (take(r.path))
      dhm.push({
        path: r.path,
        label: `${r.name || baseName(r.path)} · ${formatBytes(r.size)}`,
      });
  const recent: Choice[] = [];
  const events: { path: string; at: number }[] = [
    ...history.map((r) => ({ path: r.path, at: r.timestamp })),
    ...list
      .filter((s) => s.snapshotType === "comparison")
      .flatMap((s) =>
        [s.rootPath, s.targetPath || ""].map((path) => ({
          path,
          at: Date.parse(s.savedAt),
        })),
      ),
  ].sort((a, b) => b.at - a.at);
  for (const e of events)
    if (take(e.path)) recent.push({ path: e.path, label: baseName(e.path) });
  return { scans, dhm, recent };
}

interface Props {
  /** The placeholder shown before a choice, e.g. "COMPARE WITH…". */
  label: string;
  exclude?: string[];
  disabled?: boolean;
  title?: string;
  className?: string;
  onPick: (path: string) => void;
}

export function FolderChoice({
  label,
  exclude = [],
  disabled,
  title,
  className = "",
  onPick,
}: Props) {
  const { scans, dhm, recent } = useChoices(exclude);
  return (
    <select
      className={`lcd-input folder-choice ${className}`}
      value=""
      aria-label={label}
      title={title}
      disabled={disabled}
      onChange={async (e) => {
        const value = e.target.value;
        e.target.value = "";
        if (value === BROWSE) {
          const picked = await pickDirectory();
          if (picked) onPick(picked);
        } else if (value) onPick(value);
      }}
    >
      <option value="">{label}</option>
      {scans.length ? (
        <optgroup label="SAVED SCANS">
          {scans.map((c) => (
            <option key={c.path} value={c.path} title={c.path}>
              {c.label}
            </option>
          ))}
        </optgroup>
      ) : null}
      {dhm.length ? (
        <optgroup label="IN DU-HAST-MUCH">
          {dhm.map((c) => (
            <option key={c.path} value={c.path} title={c.path}>
              {c.label}
            </option>
          ))}
        </optgroup>
      ) : null}
      {recent.length ? (
        <optgroup label="RECENT FOLDERS">
          {recent.map((c) => (
            <option key={c.path} value={c.path} title={c.path}>
              {c.label}
            </option>
          ))}
        </optgroup>
      ) : null}
      <option value={BROWSE}>BROWSE…</option>
    </select>
  );
}

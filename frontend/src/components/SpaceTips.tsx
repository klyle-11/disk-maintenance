/**
 * "Keeping space free" panel.
 *
 * macOS treats freed space as room for caches, snapshots and swap, so a
 * cleanup rarely sticks. These tips (the same ones `di tips` prints) explain
 * where the space goes and give the command to take it back. Tips that apply
 * to this machine come first; the rest sit behind "Show all".
 */

import { useEffect, useState } from "react";
import { formatBytes, getSpaceTips } from "../api";
import type { SpaceTips as SpaceTipsData } from "../api";
import "./SpaceTips.css";

const COLLAPSED_KEY = "spaceTipsCollapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function SpaceTips() {
  const [data, setData] = useState<SpaceTipsData | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    getSpaceTips().then(setData).catch(() => setData(null));
  }, []);

  if (!data) return null;

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      /* storage unavailable; the panel just won't remember */
    }
  };

  const copy = (id: string, command: string) => {
    navigator.clipboard?.writeText(command).then(() => {
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    });
  };

  const relevant = data.tips.filter((t) => t.relevant);
  const visible = showAll ? data.tips : relevant;

  return (
    <section className={`space-tips${data.lowSpace ? " is-low" : ""}`}>
      <button className="space-tips-header" onClick={toggle} aria-expanded={!collapsed}>
        <span className="space-tips-title">Keeping space free</span>
        <span className="space-tips-free">
          {formatBytes(data.freeBytes)} free{data.lowSpace && " — running low"}
        </span>
        <span className="space-tips-chevron" aria-hidden>
          {collapsed ? "▸" : "▾"}
        </span>
      </button>

      {!collapsed && (
        <>
          <ul className="space-tips-list">
            {visible.map((tip) => (
              <li key={tip.id} className={tip.relevant ? "" : "is-other"}>
                <div className="space-tips-tip-title">{tip.title}</div>
                <p>{tip.body}</p>
                {tip.command && (
                  <button
                    className="space-tips-command"
                    onClick={() => copy(tip.id, tip.command)}
                    title="Copy to clipboard"
                  >
                    <code>{tip.command}</code>
                    <span>{copied === tip.id ? "Copied" : "Copy"}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
          {relevant.length < data.tips.length && (
            <button className="space-tips-more" onClick={() => setShowAll(!showAll)}>
              {showAll
                ? "Only tips for this Mac"
                : `Show all (${data.tips.length - relevant.length} more)`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Every space-keeping tip in one window (the list `di tips` prints): the ones
 * that apply to this machine first, each opening to its text and command.
 */
import { useState } from "react";
import { useApp } from "../state/app";
import { Window } from "../wm/Window";
import type { WindowArgs } from "./HubWindows";

export function TipsWindow({ view, controls }: WindowArgs) {
  const tips = useApp((s) => s.tips?.tips ?? null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const relevant = tips?.filter((t) => t.relevant) ?? [];
  const shown = all || relevant.length === 0 ? (tips ?? []) : relevant;
  const copy = (id: string, command: string) =>
    navigator.clipboard?.writeText(command).then(() => {
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    });

  return (
    <Window
      title="TIPS"
      shadeInfo={tips ? `${relevant.length} apply here` : undefined}
      view={view}
      controls={controls}
      className="kind-tips"
    >
      <div className="tool">
        <div className="field-row">
          <div className="seg is-wide" role="radiogroup" aria-label="Which tips">
            <button type="button" role="radio" aria-checked={!all} className={`seg-btn ${!all ? "is-on" : ""}`} onClick={() => setAll(false)}>
              FOR THIS MACHINE ({relevant.length})
            </button>
            <button type="button" role="radio" aria-checked={all} className={`seg-btn ${all ? "is-on" : ""}`} onClick={() => setAll(true)}>
              ALL ({tips?.length ?? 0})
            </button>
          </div>
        </div>
        <div className="lcd tips-list">
          {tips === null ? <div className="lcd-dim">Loading tips…</div> : null}
          {shown.map((tip) => {
            const open = openId === tip.id;
            return (
              <div key={tip.id} className={`tips-item ${open ? "is-open" : ""}`}>
                <button type="button" className="tips-head" aria-expanded={open} onClick={() => setOpenId(open ? null : tip.id)}>
                  <span className="section-twisty" aria-hidden>
                    {open ? "▾" : "▸"}
                  </span>
                  {tip.relevant ? <span className="led" data-on title="Applies to this machine" /> : null}
                  <span className="tips-title">{tip.title}</span>
                </button>
                {open ? (
                  <div className="tips-body">
                    <p>{tip.body}</p>
                    {tip.command ? (
                      <button type="button" className="tip-command" onClick={() => copy(tip.id, tip.command)} title="Copy to clipboard">
                        <code>$ {tip.command}</code>
                        <span className="chip">{copied === tip.id ? "COPIED" : "COPY"}</span>
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </Window>
  );
}

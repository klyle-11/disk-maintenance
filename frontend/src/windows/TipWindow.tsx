/** One space-keeping suggestion per window (the same tips `di tips` prints). */
import { useState } from "react";
import { useApp } from "../state/app";
import { Window } from "../wm/Window";
import type { WindowArgs } from "./HubWindows";

export function TipWindow({ view, controls }: WindowArgs) {
  const tipId = view.unit.ref;
  const tip = useApp((s) => s.tips?.tips.find((t) => t.id === tipId));
  const index = useApp((s) => (s.tips ? s.tips.tips.findIndex((t) => t.id === tipId) : -1));
  const count = useApp((s) => s.tips?.tips.length ?? 0);
  const [copied, setCopied] = useState(false);

  const copy = (command: string) =>
    navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });

  return (
    <Window
      title={index >= 0 ? `TIP ${index + 1} / ${count}` : "TIP"}
      shadeInfo={tip?.title}
      view={view}
      controls={controls}
      className={`kind-tip ${tip?.relevant ? "is-relevant" : ""}`}
    >
      <div className="lcd tip">
        {tip ? (
          <>
            <div className="tip-title">
              {tip.relevant ? <span className="led" data-on title="Applies to this machine" /> : null}
              {tip.title}
            </div>
            <p className="tip-body">{tip.body}</p>
            {tip.command ? (
              <button type="button" className="tip-command" onClick={() => copy(tip.command)} title="Copy to clipboard">
                <code>$ {tip.command}</code>
                <span className="chip">{copied ? "COPIED" : "COPY"}</span>
              </button>
            ) : null}
          </>
        ) : (
          <div className="lcd-dim">Loading tip…</div>
        )}
      </div>
    </Window>
  );
}

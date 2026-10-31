/** The single-content windows: du-hast-much, di and the space tips. */
import { useState } from "react";
import { getDuHastMuchHistory } from "../api";
import { DuHastMuch } from "../components/DuHastMuch";
import { SpaceTips } from "../components/SpaceTips";
import { Window } from "../wm/Window";
import type { UnitControls, UnitView } from "../wm/Cluster";
import { DiTerminal } from "./DiTerminal";

interface ToolWindowProps {
  view: UnitView;
  controls: UnitControls;
  connected: boolean;
}

export function DhmWindow({ view, controls }: ToolWindowProps) {
  // Reopens showing the last scan, as the app always has.
  const [latest] = useState(() => getDuHastMuchHistory()[0] ?? null);
  return (
    <Window title="DU-HAST-MUCH" shadeInfo="folder sizes" view={view} controls={controls} className="kind-dhm">
      <DuHastMuch initialResult={latest} />
    </Window>
  );
}

export function DiWindow({ view, controls, connected }: ToolWindowProps) {
  return (
    <Window title="DI · COMMAND LINE" shadeInfo="di" view={view} controls={controls} className="kind-di">
      <DiTerminal connected={connected} />
    </Window>
  );
}

export function TipsWindow({ view, controls, connected }: ToolWindowProps) {
  return (
    <Window title="KEEPING SPACE FREE" view={view} controls={controls} className="kind-tips">
      {connected ? <SpaceTips /> : <div className="lcd pad lcd-dim">Waiting for the backend…</div>}
    </Window>
  );
}

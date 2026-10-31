/**
 * di as two windows: the terminal, and its command suggestions. Commands run
 * as real di processes in the backend and stream their coloured output.
 */
import { useEffect, useRef } from "react";
import { ansiCss, parseAnsi, type AnsiSegment } from "../ansi";
import { useApp } from "../state/app";
import { diHistory, runDi, setDiColumns, setDiInput, stopDi, clearDi, useDi, visible } from "../state/di";
import { openWindow } from "../wm/state";
import { Window } from "../wm/Window";
import type { WindowArgs } from "./HubWindows";
import { pickDirectory } from "./pickDirectory";

const QUICK = ["summary", "scan ~ -d 1", "recent ~", "reclaim ~", "caches", "tips", "snapshots"];

function Segments({ segments }: { segments: AnsiSegment[] }) {
  return (
    <>
      {segments.map((seg, i) => (
        <span key={i} style={ansiCss(seg.style)}>
          {seg.text}
        </span>
      ))}
    </>
  );
}

function quote(path: string): string {
  return /[\s'"]/.test(path) ? `"${path}"` : path;
}

function focusPrompt(): void {
  document.querySelector<HTMLInputElement>(".di-prompt input")?.focus();
}

export function DiWindow({ view, controls }: WindowArgs) {
  const ready = useApp((s) => s.connected === true);
  const lines = useDi((s) => s.lines);
  const live = useDi((s) => s.live);
  const input = useDi((s) => s.input);
  const running = useDi((s) => s.running);
  const outputRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const stickRef = useRef(true);

  // di lays its tables out for the terminal's width.
  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const charWidth = (measureRef.current?.offsetWidth ?? 70) / 10;
      if (charWidth) setDiColumns(Math.max(40, Math.floor((el.clientWidth - 16) / charWidth)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Keep the newest output in view unless the user scrolled back.
  useEffect(() => {
    const el = outputRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines, live]);

  const submit = (text: string) => {
    stickRef.current = true;
    void runDi(text).then(focusPrompt);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit(input);
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      diHistory(1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      diHistory(-1);
    } else if (e.key === "c" && e.ctrlKey && running) {
      e.preventDefault();
      stopDi();
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      clearDi();
    } else if (e.key === "Escape") setDiInput("");
  };

  const liveLine = visible(live);

  return (
    <Window title="DI · COMMAND LINE" shadeInfo={running ? "running…" : "di"} view={view} controls={controls} className="kind-di">
      <div className="di" onClick={() => window.getSelection()?.isCollapsed && focusPrompt()}>
        <div
          className="lcd term"
          ref={outputRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
          }}
        >
          <span className="term-measure" ref={measureRef} aria-hidden>
            0000000000
          </span>
          {lines.length === 0 && !running ? (
            <div className="lcd-dim">
              {ready ? "di — type a command, or pick one in DI · COMMANDS" : "waiting for the backend…"}
            </div>
          ) : null}
          {lines.map((line) => (
            <div key={line.id} className="term-line">
              <Segments segments={line.segments} />
            </div>
          ))}
          {liveLine ? (
            <div className="term-line">
              <Segments segments={parseAnsi(liveLine).segments} />
            </div>
          ) : null}
        </div>
        <div className="di-prompt">
          <span className="di-ps1">di›</span>
          <input
            className="lcd-input"
            value={input}
            onChange={(e) => setDiInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={running ? "running… (ctrl+c stops)" : "scan ~/dev -d 1"}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-label="di command"
            disabled={!ready}
          />
          <button
            type="button"
            className="steel-btn"
            disabled={!ready}
            title="Insert a folder path"
            onClick={async () => {
              const path = await pickDirectory();
              if (path) setDiInput(`${input}${input && !input.endsWith(" ") ? " " : ""}${quote(path)}`);
              focusPrompt();
            }}
          >
            PATH
          </button>
          {running ? (
            <button type="button" className="steel-btn is-warn" onClick={stopDi}>
              STOP
            </button>
          ) : (
            <button type="button" className="steel-btn is-primary" onClick={() => submit(input)} disabled={!ready || !input.trim()}>
              RUN
            </button>
          )}
        </div>
      </div>
    </Window>
  );
}

export function DiCmdsWindow({ view, controls }: WindowArgs) {
  const ready = useApp((s) => s.connected === true);
  const commands = useDi((s) => s.commands);
  const running = useDi((s) => s.running);

  // The terminal is where commands run; bring it back if it was closed.
  const toTerminal = () => openWindow("di");

  return (
    <Window title="DI · COMMANDS" shadeInfo={`${commands.length} commands`} view={view} controls={controls} className="kind-di-cmds">
      <div className="lcd suggestions">
        <div className="suggest-head">RUN NOW</div>
        <div className="suggest-quick">
          {QUICK.map((cmd) => (
            <button
              key={cmd}
              type="button"
              className="chip is-cmd"
              disabled={running || !ready}
              onClick={() => {
                toTerminal();
                void runDi(cmd);
              }}
            >
              {cmd}
            </button>
          ))}
        </div>
        <div className="suggest-head">COMMANDS</div>
        {commands.length === 0 ? <div className="lcd-dim">{ready ? "loading…" : "waiting for the backend…"}</div> : null}
        {commands.map((c) => (
          <button
            key={c.name}
            type="button"
            className="suggest-cmd"
            title={`Type “${c.name}” into the terminal`}
            onClick={() => {
              toTerminal();
              setDiInput(`${c.name} `);
              setTimeout(focusPrompt, 50);
            }}
          >
            <span className="suggest-name">{c.name}</span>
            <span className="suggest-help">{c.help}</span>
          </button>
        ))}
      </div>
    </Window>
  );
}

/**
 * The di window: a terminal onto the real `di` command line.
 *
 * Commands run in the backend as real di processes and their coloured output
 * streams in as it is printed, spinner and all. Anything that deletes or
 * schedules something (clean --yes, guard --install, ...) asks first.
 */
import { useEffect, useRef, useState } from "react";
import {
  DiConfirmError,
  getDiCommands,
  splitCommandLine,
  startDiRun,
  streamDiRun,
  type DiCommand,
} from "../api";
import { ansiCss, parseAnsi, type AnsiSegment, type AnsiStyle } from "../ansi";
import { pickDirectory } from "./pickDirectory";

const MAX_LINES = 4000;
const HISTORY_KEY = "di-history";
const QUICK = ["summary", "scan ~ -d 1", "recent ~", "reclaim ~", "caches", "tips", "snapshots"];

interface Line {
  id: number;
  segments: AnsiSegment[];
}

function readHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

/** Resolve a terminal line's \r redraws to what ends up on screen. */
function visible(text: string): string {
  const line = text.endsWith("\r") ? text.slice(0, -1) : text;
  const cr = line.lastIndexOf("\r");
  return cr >= 0 ? line.slice(cr + 1) : line;
}

function quote(path: string): string {
  return /[\s'"]/.test(path) ? `"${path}"` : path;
}

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

export function DiTerminal({ connected }: { connected: boolean }) {
  const [lines, setLines] = useState<Line[]>([]);
  // The line di is still writing (a spinner redraws it in place).
  const [live, setLive] = useState("");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [commands, setCommands] = useState<DiCommand[]>([]);
  const [history, setHistory] = useState<string[]>(readHistory);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const outputRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stickRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const partialRef = useRef("");
  const styleRef = useRef<AnsiStyle>({});
  const nextIdRef = useRef(0);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    getDiCommands()
      .then((list) => !cancelled && setCommands(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connected]);

  // Keep the newest output in view unless the user scrolled back.
  useEffect(() => {
    const el = outputRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines, live]);

  // A closed window stops its command.
  useEffect(() => () => abortRef.current?.abort(), []);

  const append = (segmentLists: AnsiSegment[][]) => {
    if (segmentLists.length === 0) return;
    const added = segmentLists.map((segments) => ({ id: nextIdRef.current++, segments }));
    setLines((prev) => {
      const next = [...prev, ...added];
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  };

  const note = (text: string, style: AnsiStyle = { dim: true }) => append([[{ text, style }]]);

  const parseLine = (text: string): AnsiSegment[] => {
    const { segments, end } = parseAnsi(visible(text), styleRef.current);
    styleRef.current = end;
    return segments;
  };

  const feed = (text: string) => {
    const parts = (partialRef.current + text).split("\n");
    partialRef.current = parts.pop() ?? "";
    append(parts.map(parseLine));
    setLive(partialRef.current);
  };

  const flush = () => {
    if (visible(partialRef.current).trim()) append([parseLine(partialRef.current)]);
    partialRef.current = "";
    styleRef.current = {};
    setLive("");
  };

  const columns = () => {
    const el = outputRef.current;
    const charWidth = (measureRef.current?.offsetWidth ?? 70) / 10;
    if (!el || !charWidth) return 100;
    return Math.max(40, Math.floor((el.clientWidth - 16) / charWidth));
  };

  const remember = (text: string) => {
    const next = [text, ...history.filter((h) => h !== text)].slice(0, 50);
    setHistory(next);
    setHistoryIndex(-1);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // History just won't survive a restart.
    }
  };

  const run = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || running) return;
    let args = splitCommandLine(trimmed);
    if (args[0] === "di") args = args.slice(1);
    remember(trimmed);
    if (args[0] === "clear" || args[0] === "cls") {
      setLines([]);
      return;
    }

    stickRef.current = true;
    append([[
      { text: "di› ", style: { fg: "var(--lcd-accent)", bold: true } },
      { text: args.join(" "), style: { bold: true } },
    ]]);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const width = columns();
      let runId: string;
      try {
        runId = await startDiRun(args, width);
      } catch (err) {
        if (!(err instanceof DiConfirmError)) throw err;
        if (!window.confirm(`${err.message}.\n\nRun “di ${args.join(" ")}” anyway?`)) {
          note("not run");
          return;
        }
        runId = await startDiRun(args, width, true);
      }
      if (controller.signal.aborted) return;
      await streamDiRun(
        runId,
        {
          onOutput: feed,
          onExit: (code, elapsed) => {
            flush();
            if (code === 0) note(`✓ ${elapsed.toFixed(1)}s`);
            else note(`exit ${code} · ${elapsed.toFixed(1)}s`, { fg: "var(--ansi-red)" });
          },
        },
        controller.signal,
      );
    } catch (err) {
      flush();
      if (controller.signal.aborted) note("^C stopped", { fg: "var(--ansi-yellow)" });
      else note(err instanceof Error ? err.message : String(err), { fg: "var(--ansi-red)" });
    } finally {
      abortRef.current = null;
      setRunning(false);
      inputRef.current?.focus();
    }
  };

  const submit = (text: string) => {
    setInput("");
    void run(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      submit(input);
    } else if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const i = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(i);
      setInput(history[i]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const i = historyIndex - 1;
      setHistoryIndex(Math.max(i, -1));
      setInput(i >= 0 ? history[i] : "");
    } else if (e.key === "c" && e.ctrlKey && running) {
      e.preventDefault();
      abortRef.current?.abort();
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    } else if (e.key === "Escape") {
      setInput("");
    }
  };

  const insertPath = async () => {
    const path = await pickDirectory();
    if (!path) return;
    setInput((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}${quote(path)}`);
    inputRef.current?.focus();
  };

  const liveLine = visible(live);

  return (
    <div className="di-term" onClick={() => window.getSelection()?.isCollapsed && inputRef.current?.focus()}>
      <div className="lcd-toolbar">
        {QUICK.map((cmd) => (
          <button key={cmd} type="button" className="chip" disabled={running || !connected} onClick={() => submit(cmd)}>
            {cmd}
          </button>
        ))}
      </div>

      <div
        className="lcd di-term-output"
        ref={outputRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        }}
      >
        <span className="di-term-measure" ref={measureRef} aria-hidden>
          0000000000
        </span>
        {lines.length === 0 && !running ? (
          <div className="di-term-intro">
            <div className="lcd-strong">di — Disk Intelligence command line</div>
            <div className="lcd-dim">
              {connected ? "type a command, or pick one:" : "waiting for the backend…"}
            </div>
            {commands.map((c) => (
              <button
                key={c.name}
                type="button"
                className="di-term-cmd"
                onClick={() => {
                  setInput(`${c.name} `);
                  inputRef.current?.focus();
                }}
              >
                <span>{c.name}</span>
                <span className="lcd-dim">{c.help}</span>
              </button>
            ))}
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

      <div className="di-term-prompt">
        <span className="di-term-ps1">di›</span>
        <input
          ref={inputRef}
          className="lcd-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={running ? "running… (ctrl+c stops)" : "scan ~/dev -d 1"}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label="di command"
          disabled={!connected}
        />
        <button type="button" className="steel-btn" onClick={insertPath} disabled={!connected} title="Insert a folder path">
          PATH
        </button>
        {running ? (
          <button type="button" className="steel-btn is-warn" onClick={() => abortRef.current?.abort()}>
            STOP
          </button>
        ) : (
          <button type="button" className="steel-btn" onClick={() => submit(input)} disabled={!connected || !input.trim()}>
            RUN
          </button>
        )}
      </div>
    </div>
  );
}

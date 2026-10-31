/**
 * ANSI SGR colour codes → styled spans, for terminal output drawn in a window.
 *
 * The 16 basic colours map to skin variables (--ansi-red, --ansi-bright-cyan,
 * ...) so CLI output matches the skin it's shown in; 256-colour and
 * true-colour codes are drawn as given. Cursor and erase sequences are
 * dropped: callers resolve \r redraws before handing lines over.
 */
import type { CSSProperties } from "react";

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const CUBE = [0, 95, 135, 175, 215, 255];

function basic(n: number, bright: boolean): string {
  return `var(--ansi-${bright ? "bright-" : ""}${NAMES[n]})`;
}

function color256(n: number): string {
  if (n < 8) return basic(n, false);
  if (n < 16) return basic(n - 8, true);
  if (n < 232) {
    const i = n - 16;
    return `rgb(${CUBE[Math.floor(i / 36)]}, ${CUBE[Math.floor(i / 6) % 6]}, ${CUBE[i % 6]})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function applyCodes(style: AnsiStyle, params: string): AnsiStyle {
  const codes = params === "" ? [0] : params.split(";").map((c) => parseInt(c, 10) || 0);
  let next = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) next.bold = next.dim = false;
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code >= 30 && code <= 37) next.fg = basic(code - 30, false);
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = basic(code - 40, false);
    else if (code === 49) delete next.bg;
    else if (code >= 90 && code <= 97) next.fg = basic(code - 90, true);
    else if (code >= 100 && code <= 107) next.bg = basic(code - 100, true);
    else if (code === 38 || code === 48) {
      let value: string | undefined;
      if (codes[i + 1] === 5) {
        value = color256(codes[i + 2] ?? 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        value = `rgb(${codes[i + 2] ?? 0}, ${codes[i + 3] ?? 0}, ${codes[i + 4] ?? 0})`;
        i += 4;
      }
      if (value) next[code === 38 ? "fg" : "bg"] = value;
    }
  }
  return next;
}

// CSI sequences (colour and otherwise), plus lone ESC + one character.
// eslint-disable-next-line no-control-regex -- matching ESC is the point
const ESCAPES = /\x1b\[([0-9;?]*)([@-~])|\x1b[^[]/g;

/**
 * Split one line into styled segments. `start` is the style carried over from
 * the previous line; the style in force at the end comes back as `end`.
 */
export function parseAnsi(line: string, start: AnsiStyle = {}): { segments: AnsiSegment[]; end: AnsiStyle } {
  const segments: AnsiSegment[] = [];
  let style = start;
  let last = 0;
  for (const match of line.matchAll(ESCAPES)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ text: line.slice(last, index), style });
    if (match[2] === "m") style = applyCodes(style, match[1]);
    last = index + match[0].length;
  }
  if (last < line.length) segments.push({ text: line.slice(last), style });
  return { segments, end: style };
}

export function stripAnsi(text: string): string {
  return text.replace(ESCAPES, "");
}

/** Inline style for a segment; undefined for plain text. */
export function ansiCss(style: AnsiStyle): CSSProperties | undefined {
  const fg = style.inverse ? style.bg ?? "var(--lcd-bg)" : style.fg;
  const bg = style.inverse ? style.fg ?? "var(--lcd-text)" : style.bg;
  if (!fg && !bg && !style.bold && !style.dim && !style.italic && !style.underline) return undefined;
  return {
    color: fg,
    background: bg,
    fontWeight: style.bold ? 700 : undefined,
    opacity: style.dim ? 0.62 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: style.underline ? "underline" : undefined,
  };
}

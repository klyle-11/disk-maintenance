/**
 * A collapsible part of a window: a header that opens and closes it, and its
 * body. A "fill" section takes the window's remaining height when open.
 */
import type { ReactNode } from "react";

interface SectionProps {
  title: string;
  /** Short text after the title (a count, a path). */
  info?: ReactNode;
  open: boolean;
  onToggle: () => void;
  fill?: boolean;
  children: ReactNode;
}

export function Section({ title, info, open, onToggle, fill = false, children }: SectionProps) {
  return (
    <div className={`section ${open ? "is-open" : ""} ${fill ? "is-fill" : ""}`}>
      <button type="button" className="section-head" onClick={onToggle} aria-expanded={open}>
        <span className="section-twisty" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span className="section-title">{title}</span>
        {info != null ? <span className="section-info">{info}</span> : null}
      </button>
      {open ? <div className="section-body">{children}</div> : null}
    </div>
  );
}

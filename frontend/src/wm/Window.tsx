/**
 * One window's chrome: grooved title bar, shade and close buttons, resize
 * edges and the corner grip. Content goes in the body.
 */
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Rect } from "./layout";
import type { Handle, UnitControls, UnitView } from "./Cluster";

const EDGES: Handle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

interface WindowProps {
  title: string;
  /** Short text shown in the title bar while shaded. */
  shadeInfo?: string;
  view: UnitView;
  controls: UnitControls;
  /** For a member of a pair: where it sits, and which member it is. */
  rect?: Rect;
  member?: number;
  className?: string;
  closable?: boolean;
  /** Overrides the close button (e.g. to confirm first). */
  onClose?: () => void;
  children: ReactNode;
}

export function Window({
  title,
  shadeInfo,
  view,
  controls,
  rect = view.rect,
  member = 0,
  className = "",
  closable = true,
  onClose,
  children,
}: WindowProps) {
  const shaded = view.unit.shaded;
  const ref = useRef<HTMLElement>(null);

  // A window that was just opened or asked for scrolls into view if the
  // cluster is larger than the screen.
  useEffect(() => {
    if (view.flashKey == null) return;
    const timer = setTimeout(
      () => ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" }),
      250,
    );
    return () => clearTimeout(timer);
  }, [view.flashKey]);

  const style: CSSProperties = {
    left: rect.x,
    top: rect.y,
    width: rect.w,
    height: rect.h,
    transform: view.dragOffset ? `translate(${view.dragOffset.x}px, ${view.dragOffset.y}px)` : undefined,
  };

  const onTitleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      controls.move(-1);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      controls.move(1);
    }
  };

  // Buttons in the title bar shouldn't start a drag.
  const stop = (e: ReactPointerEvent) => e.stopPropagation();

  return (
    <section
      ref={ref}
      className={[
        "wm-window",
        className,
        view.active ? "is-active" : "",
        shaded ? "is-shaded" : "",
        view.dragging ? "is-dragging" : "",
        view.dropTarget ? "is-drop-target" : "",
        view.resizing ? "is-resizing" : "",
      ].join(" ")}
      style={style}
      aria-label={title}
      onPointerDownCapture={controls.activate}
    >
      <header
        className="wm-titlebar"
        tabIndex={0}
        title="Drag onto another window to swap places · double-click to shade · arrow keys reorder"
        onPointerDown={controls.beginDrag}
        onDoubleClick={controls.shade}
        onKeyDown={onTitleKeyDown}
      >
        <span className="wm-grooves" aria-hidden />
        <span className="wm-title">{title}</span>
        {shaded && shadeInfo ? <span className="wm-shade-info">{shadeInfo}</span> : null}
        <span className="wm-grooves" aria-hidden />
        <span className="wm-buttons" onPointerDown={stop}>
          <button
            type="button"
            className="wm-btn wm-btn-shade"
            onClick={controls.shade}
            aria-label={shaded ? "Unshade" : "Shade"}
            title={shaded ? "Unshade" : "Shade"}
          />
          {closable ? (
            <button
              type="button"
              className="wm-btn wm-btn-close"
              onClick={onClose ?? controls.close}
              aria-label="Close"
              title="Close"
            />
          ) : null}
        </span>
      </header>
      <div className="wm-body" hidden={shaded}>
        {children}
      </div>
      {shaded
        ? null
        : EDGES.map((handle) => (
            <div
              key={handle}
              className={`wm-edge wm-edge-${handle}`}
              onPointerDown={(e) => controls.beginResize(e, member, handle)}
            />
          ))}
      {shaded ? null : (
        <div
          className="wm-grip"
          aria-hidden
          onPointerDown={(e) => controls.beginResize(e, member, "se")}
        />
      )}
      {view.flashKey != null ? <span key={view.flashKey} className="wm-flash" aria-hidden /> : null}
    </section>
  );
}

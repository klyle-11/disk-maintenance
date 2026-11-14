/**
 * Keeps a window at least as tall as what it shows.
 *
 * A window whose content is a column of fixed rows around one list that takes
 * the remaining height has a least height: every row, plus the list at its
 * minimum. That height changes as rows appear, wrap or collapse, so it is
 * measured from the content itself rather than written down as a number. The
 * window manager then refuses to make the window shorter, and grows it when
 * the content starts needing more.
 *
 * Put the returned ref on the element that holds the content. It must be the
 * only child of the window's scroll box and stretch to fill it (flex-grow, or
 * min-height: 100%); the lists inside must have a fixed flex-basis and a
 * min-height, so that their content doesn't count.
 */
import { useLayoutEffect, useRef } from "react";
import { wmDispatch } from "./state";

/** The height `el` takes when nothing stretches it. */
function naturalHeight(el: HTMLElement): number {
  const { flexGrow, minHeight } = el.style;
  el.style.flexGrow = "0";
  el.style.minHeight = "0";
  const h = el.getBoundingClientRect().height;
  el.style.flexGrow = flexGrow;
  el.style.minHeight = minHeight;
  return h;
}

export function useContentFloor<T extends HTMLElement = HTMLDivElement>(id: string, shaded: boolean) {
  const content = useRef<T>(null);
  useLayoutEffect(() => {
    const el = content.current;
    const box = el?.parentElement;
    const win = el?.closest<HTMLElement>(".wm-window");
    if (!el || !box || !win || shaded) return;
    const measure = () => {
      // Hidden (shaded, or not laid out yet): nothing to go by.
      if (!box.clientHeight) return;
      const style = getComputedStyle(box);
      const room = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      // Everything of the window that isn't room for the content: title bar, frame, padding.
      const chrome = win.offsetHeight - room;
      wmDispatch({ type: "floor", id, h: chrome + naturalHeight(el) });
    };
    measure();
    // Width changes rewrap rows; anything added, removed or retyped changes what is needed.
    const resized = new ResizeObserver(measure);
    resized.observe(box);
    const changed = new MutationObserver(measure);
    changed.observe(el, { childList: true, subtree: true, characterData: true });
    // Text measured before the fonts arrived has the wrong height.
    void document.fonts?.ready.then(measure);
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, [id, shaded]);
  return content;
}

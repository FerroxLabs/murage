// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where a floating menu opened from a sidebar row goes. The menus used to
// guess their own height ("innerHeight - 380") and a bot menu with every
// entry showing is taller than that guess, so on a 900px window a row in the
// lower half put Archive and Delete below the window edge, out of reach.
// The menu is now measured and placed with these rules:
//   1. below the anchor when it fits there;
//   2. otherwise above the anchor when it fits there;
//   3. otherwise clamped inside the window, and when it is taller than the
//      window it gets a max height and scrolls inside.
import { useLayoutEffect, useRef, useState } from "react";

/** Where a menu was asked to open. `y` is the preferred top edge (the
 *  pointer, or the bottom of the control that opened it). `anchorTop`, when
 *  the menu hangs off a control, is that control's top edge: a menu flipped
 *  above opens from there so it does not cover the control. */
export interface MenuAnchor {
  x: number;
  y: number;
  anchorTop?: number;
}

export interface MenuPlacement {
  top: number;
  left: number;
  /** Set only when the menu is taller than the window allows. */
  maxHeight?: number;
}

export const MENU_EDGE = 8;

export function placeAnchoredMenu(
  anchor: MenuAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  edge = MENU_EDGE,
): MenuPlacement {
  const room = Math.max(0, viewport.height - edge * 2);
  const left = Math.max(edge, Math.min(anchor.x, viewport.width - edge - size.width));
  if (size.height > room) return { top: edge, left, maxHeight: room };
  if (anchor.y + size.height <= viewport.height - edge) return { top: Math.max(edge, anchor.y), left };
  const flipFrom = anchor.anchorTop ?? anchor.y;
  if (flipFrom - size.height >= edge) return { top: flipFrom - size.height, left };
  return { top: Math.max(edge, viewport.height - edge - size.height), left };
}

/** Measure the rendered menu and keep it inside the window. The first paint
 *  uses the anchor as is; the layout effect corrects it before the browser
 *  paints, and again whenever the menu's size or the window changes. */
export function useAnchoredMenu<T extends HTMLElement>(anchor: MenuAnchor) {
  const ref = useRef<T>(null);
  const [placement, setPlacement] = useState<MenuPlacement>({ top: Math.max(MENU_EDGE, anchor.y), left: Math.max(MENU_EDGE, anchor.x) });
  const { x, y, anchorTop } = anchor;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      // scrollHeight is the full content height even while a max height
      // clips it (the borders are added back), so a window that grows back
      // lets the menu grow back too.
      const next = placeAnchoredMenu(
        { x, y, anchorTop },
        { width: element.offsetWidth, height: element.scrollHeight + element.offsetHeight - element.clientHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPlacement((current) =>
        current.top === next.top && current.left === next.left && current.maxHeight === next.maxHeight ? current : next,
      );
    };
    place();
    window.addEventListener("resize", place);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [x, y, anchorTop]);
  const style = { top: placement.top, left: placement.left, maxHeight: placement.maxHeight };
  return { ref, style };
}

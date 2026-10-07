// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { dragReady, dropAt, edgeScroll, type DropCell } from "./project-board-pointer";
import type { ProjectCard } from "./project-client";
export type PointerDrop = NonNullable<ReturnType<typeof dropAt>>;
export function useBoardPointer(container: RefObject<HTMLDivElement | null>, enabled: boolean, onDrop: (cardId: string, target: PointerDrop) => void, onCancel: (id: string) => void) {
  const [drag, setDrag] = useState<{ card: ProjectCard; x: number; y: number; target: PointerDrop | null } | null>(null);
  const cancel = useRef<(() => void) | null>(null), suppressClick = useRef(false);
  const callbacks = useRef({ onDrop, onCancel }); callbacks.current = { onDrop, onCancel };
  useEffect(() => () => cancel.current?.(), []);
  useEffect(() => { if (!enabled) cancel.current?.(); }, [enabled]);
  const pointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, card: ProjectCard) => {
    if (!enabled || event.button !== 0 || !event.isPrimary || cancel.current) return;
    const el = container.current; if (!el) return;
    const button = event.currentTarget, pointerId = event.pointerId, type = event.pointerType;
    const start = { x: event.clientX, y: event.clientY, at: performance.now() };
    let x = start.x, y = start.y, active = false, cancelled = false, raf = 0;
    let cells: DropCell[] = [], target: PointerDrop | null = null, rect: DOMRect;
    let scrollLeft = 0, scrollTop = 0;
    const snapshot = () => {
      rect = el.getBoundingClientRect(); scrollLeft = el.scrollLeft; scrollTop = el.scrollTop;
      cells = Array.from(el.querySelectorAll<HTMLElement>("[data-board-cell]")).map(cell => {
        // The whole column (its header included) takes the drop: near the top
        // edge the board auto-scrolls, which can leave the pointer over the
        // header, and a drop there means "first in this column".
        const r = (cell.closest<HTMLElement>(".project-board-column") ?? cell).getBoundingClientRect();
        return { columnId: cell.dataset.columnId!, lane: cell.dataset.lane ?? "", left: r.left, right: r.right, top: r.top, bottom: r.bottom,
          cards: Array.from(cell.querySelectorAll<HTMLElement>("[data-card-box]")).filter(c => c.dataset.cardBox !== card.id).map(c => { const r = c.getBoundingClientRect(); return { id: c.dataset.cardBox!, midpoint: r.top + r.height / 2 }; }) };
      });
    };
    // Cell rects are cached at drag start. The board's own scroll moves its
    // content, and an ancestor scroll (the page, or the room pane) moves the
    // whole board: both shift where a cached cell now sits on screen.
    const offset = (): [number, number] => {
      const now = el.getBoundingClientRect();
      return [el.scrollLeft - scrollLeft - (now.left - rect.left), el.scrollTop - scrollTop - (now.top - rect.top)];
    };
    const tick = () => {
      if (!active || cancelled) return;
      el.scrollLeft += edgeScroll(x, rect.left, rect.right); el.scrollTop += edgeScroll(y, rect.top, rect.bottom);
      target = dropAt(cells, x, y, ...offset());
      setDrag({ card, x, y, target }); raf = requestAnimationFrame(tick);
    };
    const activate = () => {
      if (cancelled || active) return;
      active = true; suppressClick.current = true; snapshot();
      button.setPointerCapture?.(pointerId);
      raf = requestAnimationFrame(tick);
    };
    const timer = setTimeout(() => { if (type === "touch" && dragReady(type, x - start.x, y - start.y, performance.now() - start.at)) activate(); }, 300);
    const finish = (drop: boolean) => {
      if (cancelled) return; cancelled = true; clearTimeout(timer); cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", abort); window.removeEventListener("keydown", key); window.removeEventListener("touchmove", touch);
      if (button.hasPointerCapture?.(pointerId)) button.releasePointerCapture(pointerId);
      cancel.current = null; setDrag(null);
      if (active) { if (drop && target) callbacks.current.onDrop(card.id, target); else callbacks.current.onCancel(card.id); }
      setTimeout(() => { suppressClick.current = false; }, 0);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      x = e.clientX; y = e.clientY;
      if (!active && type === "touch" && Math.hypot(x - start.x, y - start.y) >= 8) { finish(false); return; }
      if (!active && dragReady(type, x - start.x, y - start.y, performance.now() - start.at)) activate();
      if (active) e.preventDefault();
    };
    const up = (e: PointerEvent) => { if (e.pointerId === pointerId) { if (active) target = dropAt(cells, e.clientX, e.clientY, ...offset()); finish(true); } };
    const abort = () => finish(false);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); finish(false); } };
    const touch = (e: TouchEvent) => { if (active) e.preventDefault(); };
    cancel.current = abort;
    window.addEventListener("pointermove", move, { passive: false }); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", abort); window.addEventListener("keydown", key); window.addEventListener("touchmove", touch, { passive: false });
  }, [container, enabled]);
  return { drag, pointerDown, suppressClick };
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
export interface DropCell { columnId: string; lane: string; left: number; right: number; top: number; bottom: number; cards: Array<{ id: string; midpoint: number }> }
export function dragReady(type: string, dx: number, dy: number, elapsed: number): boolean {
  return type === "touch" ? elapsed >= 300 && Math.hypot(dx, dy) < 8 : Math.hypot(dx, dy) >= 4;
}
export function dropAt(cells: DropCell[], x: number, y: number, scrollX: number, scrollY: number) {
  const cell = cells.find(c => x + scrollX >= c.left && x + scrollX <= c.right && y + scrollY >= c.top && y + scrollY <= c.bottom);
  if (!cell) return null;
  const at = cell.cards.findIndex(c => y + scrollY < c.midpoint);
  const index = at < 0 ? cell.cards.length : at;
  return { columnId: cell.columnId, lane: cell.lane, index, beforeId: cell.cards[index]?.id };
}
export function edgeScroll(point: number, start: number, end: number): number {
  const edge = 40;
  return point < start + edge ? -Math.ceil(12 * Math.min(1, (start + edge - point) / edge)) : point > end - edge ? Math.ceil(12 * Math.min(1, (point - end + edge) / edge)) : 0;
}

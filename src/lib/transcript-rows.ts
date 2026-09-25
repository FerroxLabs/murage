// Two things a long transcript needs from its rows (spec §6).
//
// 1. Row anchors. Scrollback used to be kept still by shifting scrollTop by
//    the growth in scrollHeight. That is right only when rows are added above
//    and nothing leaves; with a capped window (transcript-window.ts) one step
//    can add above and remove below, or the reverse. Browser scroll anchoring
//    is off on the transcript scroller, so nothing else corrects it. A row
//    that survives the change is kept at the same distance from the top of
//    the scroller instead.
//
// 2. Seen rows. `content-visibility: auto` skips layout and paint for rows off
//    screen, sized by `contain-intrinsic-size: auto …`, the row's last rendered
//    size. A row that was never rendered has only the estimate, and on a
//    scroller without scroll anchoring the jump when it first renders lands
//    on the reader. So a row opts in (styles.css `[data-seen]`) only after it
//    has been on screen once and its real size is remembered.

export const ROW_SELECTOR = "[data-row]";
export const SEEN_ATTRIBUTE = "data-seen";

export interface ScrollAnchor {
  /** The transcript it was taken in; a switch in between drops it. */
  key: string;
  id: string;
  /** Row top minus scroller top, px, at capture. */
  offset: number;
}

interface AnchorRow {
  dataset: { row?: string };
  getBoundingClientRect(): { top: number };
}
export interface AnchorScroller {
  scrollTop: number;
  getBoundingClientRect(): { top: number };
  querySelectorAll(selector: string): ArrayLike<AnchorRow>;
}

const rowsOf = (scroller: AnchorScroller) => Array.from(scroller.querySelectorAll(ROW_SELECTOR));

export function captureRowAnchor(scroller: AnchorScroller, key: string, edge: "first" | "last"): ScrollAnchor | null {
  const rows = rowsOf(scroller);
  const row = edge === "first" ? rows[0] : rows[rows.length - 1];
  const id = row?.dataset.row;
  if (!row || !id) return null;
  return { key, id, offset: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
}

/** False when the row is no longer mounted; scrollTop is then left alone. */
export function restoreRowAnchor(scroller: AnchorScroller, anchor: ScrollAnchor): boolean {
  const row = rowsOf(scroller).find((candidate) => candidate.dataset.row === anchor.id);
  if (!row) return false;
  scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
  return true;
}

interface SeenRow {
  setAttribute(name: string, value: string): void;
}
export interface SeenRoot {
  querySelectorAll(selector: string): ArrayLike<SeenRow>;
}

/** Watch the rows not yet seen; mark each on its first appearance. Returns
 * the disconnect. Call again after rows mount; seen rows are skipped. */
export function observeSeenRows(
  root: SeenRoot,
  scroller: Element,
  Observer: typeof IntersectionObserver | undefined = globalThis.IntersectionObserver,
): () => void {
  if (!Observer) return () => {};
  const observer = new Observer((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.setAttribute(SEEN_ATTRIBUTE, "");
      observer.unobserve(entry.target);
    }
  }, { root: scroller });
  for (const row of Array.from(root.querySelectorAll(`${ROW_SELECTOR}:not([${SEEN_ATTRIBUTE}])`))) observer.observe(row as unknown as Element);
  return () => observer.disconnect();
}

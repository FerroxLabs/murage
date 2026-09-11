// Chat header priority layout (U0-T1).
//
// The header answers to the CHAT CONTAINER's width, never the window's: the
// sidebar, the computer/inspector panel and (from F4-T3) the workspace pane
// all shrink the chat column while the window stays wide. The shipped header
// made every control `shrink-0`, so the identity cluster paid for the whole
// shortage and the bot's name reached 0px long before any container
// breakpoint fired.
//
// Rather than guess pixel breakpoints, the header MEASURES itself. Layouts
// are tried from richest to leanest and the first one that fits wins:
//
//   one row, every control inline, chips with their labels
//   one row, the role label folded to its icon
//   one row, usage folded into the More menu
//   one row, the Inspector toggle folded in too
//   one row, chips trimmed to icons except the task, which keeps its title
//   one row, chips folded to icons (task count, provider mark, folder icon)
//   TWO ROWS (identity + Stop + More above, everything else below), labels back
//   two rows, chips trimmed except the task title
//   two rows, chips folded to icons
//   … then one more control relocated per step, lowest priority first …
//
// That is the design's order: fold metadata, then compact the task/model
// context, then take an intentional second row, and only then move real
// controls into the menu. The ladder never un-relocates a control and never
// returns to one row, so it cannot oscillate between two candidates that
// both fit; the chip fold is the one thing that comes back, because the
// second row exists precisely to give the task and model their names.
//
// "Fits" means no horizontal escape from the header AND a bot name that keeps
// a usable track (`nameTrackMinimum`). Relocating never unmounts a control's
// state holder: the memory dialog stays mounted and only its trigger moves,
// and the task/model pickers change flex line by class, not by re-parenting.
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Lowest priority first: each step moves the next one into the More menu.
 *
 * Bot identity, Stop, the task/model context, the call button and More itself
 * never move. Call is left in place deliberately: its availability, label and
 * voice-setup fallback live inside `CallTargetButton`, and a menu copy would
 * be a second implementation of that logic rather than the same control. It
 * is already a single icon at these widths. */
export const HEADER_RELOCATION_ORDER = [
  "roleLabel",
  "usage",
  "inspector",
  "computer",
  "find",
  "memory",
  "folder",
] as const;
export type HeaderSlot = (typeof HEADER_RELOCATION_ORDER)[number];

/** How many steps of pure metadata/diagnostics are folded away before the
 * chips are compacted or the header takes a second row. Role label, usage
 * and Inspector are exactly the three the design folds "before sacrificing
 * the name". */
export const METADATA_STEPS = 3;

/** `full`: every chip shows its label. `titled`: the task keeps its title,
 * the rest (model, folder, usage, Stop, Memory) fold to their icon/mark —
 * the one compact task/model control the design asks for at compact widths.
 * `compact`: the task folds to its count too; every label rides the tooltip. */
export type HeaderChips = "full" | "titled" | "compact";

export interface HeaderLayout {
  twoRow: boolean;
  chips: HeaderChips;
  /** How many of HEADER_RELOCATION_ORDER live in the More menu. */
  relocated: number;
}

/** Every layout, richest first, each one leaner than the last. */
export const HEADER_LAYOUTS: readonly HeaderLayout[] = [
  ...Array.from({ length: METADATA_STEPS + 1 }, (_, relocated) => ({
    twoRow: false,
    chips: "full" as const,
    relocated,
  })),
  { twoRow: false, chips: "titled", relocated: METADATA_STEPS },
  { twoRow: false, chips: "compact", relocated: METADATA_STEPS },
  { twoRow: true, chips: "full", relocated: METADATA_STEPS },
  { twoRow: true, chips: "titled", relocated: METADATA_STEPS },
  ...Array.from({ length: HEADER_RELOCATION_ORDER.length - METADATA_STEPS + 1 }, (_, step) => ({
    twoRow: true,
    chips: "compact" as const,
    relocated: METADATA_STEPS + step,
  })),
];

export function relocatedSlots(layout: HeaderLayout): Set<HeaderSlot> {
  return new Set<HeaderSlot>(HEADER_RELOCATION_ORDER.slice(0, layout.relocated));
}

/** The smallest name track a layout may leave. A short name only needs its
 * own width; a long one is guaranteed a quarter of the header, between 96px
 * (about ten characters at the header's 15px semibold) and 200px, before any
 * control gets to keep its place. */
export const NAME_TRACK_MIN_PX = 96;
export const NAME_TRACK_MAX_PX = 200;
export function nameTrackMinimum(contentWidth: number, naturalWidth: number): number {
  const target = Math.min(NAME_TRACK_MAX_PX, Math.max(NAME_TRACK_MIN_PX, contentWidth * 0.25));
  return Math.min(naturalWidth, target);
}

export interface HeaderMeasurement {
  contentWidth: number;
  /** How far anything escapes the header's content box, in px: its own
   * scrollable overflow, or a control in the secondary track that has run
   * past either edge. Leftward escape is the case `scrollWidth` alone cannot
   * see — a right-aligned row that does not fit spills to the LEFT. */
  overflow: number;
  /** Rendered width of the name button. */
  nameWidth: number;
  /** Width the full name would take (scrollWidth of the truncating button). */
  nameNatural: number;
}

export function headerFits(m: HeaderMeasurement): boolean {
  if (m.overflow > 1) return false;
  return m.nameWidth + 0.5 >= nameTrackMinimum(m.contentWidth, m.nameNatural);
}

/** Read the live header. The name is the first button (or the rename input)
 * inside `[data-chat-header-name]`. */
export function measureHeader(header: HTMLElement): HeaderMeasurement {
  const style = getComputedStyle(header);
  const contentWidth =
    header.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
  const name = header.querySelector<HTMLElement>("[data-chat-header-name] :is(button, input)");
  const box = header.getBoundingClientRect();
  const left = box.left + parseFloat(style.borderLeftWidth || "0") + parseFloat(style.paddingLeft || "0");
  const right = box.right - parseFloat(style.borderRightWidth || "0") - parseFloat(style.paddingRight || "0");
  let escape = header.scrollWidth - header.clientWidth;
  for (const child of header.querySelectorAll<HTMLElement>("[data-chat-header-secondary] > *")) {
    // Only what is laid out IN the row counts. The memory launcher's
    // <dialog> is a sibling of its trigger and, open, sits centred in the
    // top layer; a popover or menu is absolutely positioned. Neither takes
    // row width, and counting one would collapse the header to its leanest
    // layout the moment it opened.
    const position = getComputedStyle(child).position;
    if (child.tagName === "DIALOG" || position === "fixed" || position === "absolute") continue;
    const rect = child.getBoundingClientRect();
    if (rect.width === 0) continue;
    escape = Math.max(escape, left - rect.left, rect.right - right);
  }
  return {
    contentWidth,
    overflow: escape,
    nameWidth: name ? name.getBoundingClientRect().width : 0,
    nameNatural: name ? Math.max(name.scrollWidth, name.getBoundingClientRect().width) : 0,
  };
}

/** The richest layout that fits, re-chosen whenever the header's width or
 * anything that changes its content (`contentKey`) changes. Every step is a
 * synchronous layout-effect re-render, so no intermediate layout is painted. */
export function useChatHeaderLayout(
  headerRef: RefObject<HTMLElement | null>,
  contentKey: string,
): { layout: HeaderLayout; slots: Set<HeaderSlot>; contentWidth: number } {
  const [index, setIndex] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [fontsTick, setFontsTick] = useState(0);
  const lastKey = useRef(contentKey);
  const lastWidth = useRef(0);

  // Width changes: growing may let controls come back, so start over from the
  // richest layout; shrinking can only need leaner ones, so continue.
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const read = () => {
      const width = measureHeader(header).contentWidth;
      if (Math.abs(width - lastWidth.current) < 0.5) return;
      if (width > lastWidth.current) setIndex(0);
      lastWidth.current = width;
      setContentWidth(width);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(header);
    return () => observer.disconnect();
  }, [headerRef]);

  // Web fonts change every width once they land.
  useLayoutEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) setFontsTick((tick) => tick + 1);
    });
    return () => {
      live = false;
    };
  }, []);

  if (lastKey.current !== contentKey) {
    lastKey.current = contentKey;
    if (index !== 0) setIndex(0);
  }

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    if (!headerFits(measureHeader(header)) && index < HEADER_LAYOUTS.length - 1) setIndex(index + 1);
  }, [headerRef, index, contentWidth, contentKey, fontsTick]);

  // A font change restarts from the richest layout (the first `fonts.ready`
  // resolution is the initial one and changes nothing).
  const firstFonts = useRef(true);
  useLayoutEffect(() => {
    if (firstFonts.current) {
      firstFonts.current = false;
      return;
    }
    setIndex(0);
  }, [fontsTick]);

  const layout = HEADER_LAYOUTS[index] ?? HEADER_LAYOUTS[0]!;
  return { layout, slots: relocatedSlots(layout), contentWidth };
}

// The tool-chip class strings, shared by the two transcripts (ChatView's 1:1
// and GroupView's channel) because they encode a measured fix rather than a
// preference, and because the bug was in both.
//
// A chip has to hold a name it did not choose. MCP names are long, unbroken
// and unhyphenated through the middle
// (`mcp__io-github-taylorwilsdon-google-workspace-mcp__list_calendars`), and
// the previous `max-w-[480px] truncate` was a floor as much as a ceiling: a
// `white-space: nowrap` span 480px wide IS the chip's min-content width, so
// `flex-shrink` could never take the pill below it. On a 390px phone the chip
// measured 527px and ran 161px past the transcript's content edge, where
// `overflow-x-hidden` cut it — the overflow in the photograph this came from.
// The name was clipped on a 1440px desktop too: 509px of text in a 480px box.
//
//   - `min-w-0` removes the automatic minimum, so the pill can shrink;
//   - `max-w-full` stops it exceeding the row;
//   - `break-all` wraps the name inside the chip instead of cutting it;
//   - `rounded-2xl` rather than `rounded-full` so a wrapped two-line chip
//     still reads as a chip — at one line the two radii are indistinguishable.
//
// Measured at both viewports by src/e2e/transcript-width.human.spec.ts.
export const CHIP =
  "flex min-w-0 max-w-full items-center gap-2 rounded-2xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]";

/** The tool name inside a chip: wraps rather than truncates. */
export const CHIP_NAME = "min-w-0 break-all";

// ---------------------------------------------------------------------------
// The phone's way of acting on a message.
//
// The per-message rail (copy / reply / speak / regenerate / pin) is
// `opacity-0` until `group-hover`, and a phone reports `hover: none`. It was
// therefore invisible AND still reserving ~130px of every row, which is what
// squeezed the transcript to 74% of a 390px screen; `max-md:hidden md:contents`
// took it out of the flow and the transcript went to 85.6%. That fix stays.
// What follows is the capability it left behind, put back in a form that costs
// the row nothing.
//
// TAP THE BUBBLE, GET A SHEET. The three candidates:
//
//   - Long-press. The idiom every messenger taught (iMessage, WhatsApp,
//     Telegram), and the one we cannot have. iOS Safari answers a long press
//     with the system selection callout, and the only way to stop it is
//     `-webkit-touch-callout: none` plus `user-select: none` on the bubble —
//     which permanently removes the ability to select part of a message. In an
//     installed standalone PWA there is no browser chrome to fall back to, so
//     that trade is a net loss of capability, not a swap.
//   - A persistent overflow button. It has to live somewhere, and below `md`
//     the bubble is `max-w-full`: there is no column left of it or right of it
//     to put a 44px control in. Anything in the row also inherits the row's
//     `gap-1.5`, so even a zero-width element costs 6px. That is the bug again,
//     smaller.
//   - Tap the bubble. Costs the row nothing, because it adds no element to the
//     row at all — the trigger IS the bubble. It does not fight iOS: selection
//     still starts on a long press, and a tap that ends a drag of the
//     selection is ignored (see `bubbleTapOpensActions`). The sheet it opens is `fixed`, in
//     a portal, so it is out of flow by construction.
//
// The sheet rather than an inline row under the bubble: an inline row would
// change the transcript's height on tap (scroll jump, and the row can land
// anywhere on screen including out of thumb reach at the top of a 390px
// display), and it would only have room for the same unlabelled 14px glyphs.
// A bottom sheet is always in the thumb zone and has room for words.

/** Descendants of a bubble that own their own tap: a tap on one of these is
 *  theirs, not the sheet's. `details`/`summary` is the tool-payload disclosure;
 *  `a` is any link inside rendered markdown. */
export const BUBBLE_INTERACTIVE =
  'a,button,input,textarea,select,summary,details,label,[role="button"],[contenteditable="true"]';

/** Should this tap on a bubble open the phone action sheet?
 *
 *  Pure so it can be tested without a DOM. Three conditions, each one a real
 *  case rather than defensive noise:
 *
 *    - `narrow`: above `md` the rail is still there and still hovers. Desktop
 *      must not gain a tap behaviour it never had.
 *    - `onInteractive`: a link in an answer, or the "Show full message"
 *      button, already means something.
 *    - `selectedText`: a tap that ends a drag of the text selection lands on the
 *      bubble too. Hijacking it would be the long-press problem by another
 *      route — the user selected, and we would throw the selection away. */
export function bubbleTapOpensActions(input: {
  narrow: boolean;
  onInteractive: boolean;
  selectedText: string;
}): boolean {
  return input.narrow && !input.onInteractive && input.selectedText.trim().length === 0;
}

/** What the bubble gains below `md`. `cursor-pointer` is not decoration: iOS
 *  Safari will not always bubble a `click` out of a plain `div`, and a pointer
 *  cursor is the documented marker that makes it. Both utilities are
 *  `max-md:`-scoped, and neither one affects layout — `cursor` never does, and
 *  a focus ring is a box-shadow — so the row's width is untouched at every
 *  viewport. */
export const BUBBLE_TAPPABLE =
  "max-md:cursor-pointer max-md:focus-visible:ring-2 max-md:focus-visible:ring-accent/70";

/** One action in the sheet. 44px is Apple's minimum target and the number
 *  every one of these rows has to clear; `gap-3` + a label is what makes it a
 *  choice rather than a glyph hunt. */
export const SHEET_ITEM =
  "flex min-h-[44px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-[15px] text-ink transition-colors hover:bg-raised active:bg-raised disabled:cursor-not-allowed disabled:text-ink-secondary/60 disabled:hover:bg-transparent";

/** The dimmed ground behind the sheet, and the tap target that dismisses it. */
export const SHEET_BACKDROP = "msg-sheet-backdrop fixed inset-0 z-[70] bg-black/50";

/** The sheet itself. `fixed` + portalled to `<body>`, so it takes no part in
 *  the transcript's layout and no ancestor `transform` can capture it.
 *  `env(safe-area-inset-bottom)` because this app installs as a standalone
 *  PWA, where the home indicator is ours to clear. */
export const SHEET_PANEL =
  "msg-sheet fixed inset-x-0 bottom-0 z-[71] max-h-[70dvh] overflow-y-auto rounded-t-2xl border-t border-hairline/60 bg-panel px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-12px_40px_rgba(0,0,0,0.35)] outline-none";

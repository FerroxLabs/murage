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

// Chat-header chips fold to icon-only shapes when the header decides they
// must — the computer/inspector panel is open, the window is small, or the
// bot's name would otherwise lose its track — so the row stops wrapping and
// crushing the name. The header measures itself (src/lib/chat-header-layout.ts)
// and stamps `data-chat-header-chips` ("titled" or "compact"); `chip-trim:`
// and `chip-fold:` are the custom variants in src/styles.css that answer to
// it. Under "titled" every chip but the task folds; under "compact" the task
// folds too, so the task's own chip uses the `chip-fold:` pair.
//
// Kept as plain literal strings so Tailwind's scanner sees every class.

/** Round bubble, icon only — Stop. */
export const COMPACT_BUBBLE =
  "chip-trim:size-[30px] chip-trim:justify-center chip-trim:gap-0 chip-trim:p-0";

/** Round bubble, icon only — the task chip, which keeps its title one step
 * longer than the other chips. */
export const COMPACT_BUBBLE_LAST =
  "chip-fold:size-[30px] chip-fold:justify-center chip-fold:gap-0 chip-fold:p-0";

/** Rounded square, icon only — working folder, model. */
export const COMPACT_SQUARE =
  "chip-trim:size-[30px] chip-trim:justify-center chip-trim:gap-0 chip-trim:rounded-md chip-trim:p-0";

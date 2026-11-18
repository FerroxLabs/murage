// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.19 Settings email Keep/Remove (restore-park r3.4b): the owner's words and the rules that pick them. Pure: no network, no React.
// The server owns every line (a row's `line`, a refusal's `error`) and the restore state reaches the screen only through them: this
// module holds no restore phase and no window logic. The four spec lines are the restore spec's constants, word for word, used only
// where the server sent no line. Copy rules: plain, no "fixed" or "issue", no dashes, and each line says what happens next.

export const RESTORE_FINISHING_LINE = "A restore is finishing. Try again in a minute.";
export const RESTORE_FAILED_LINE = "That restore did not finish. Nothing changed. You can try again.";
export const RECONFIRM_KEPT_LINE = "Choose Keep or Remove again for this bot's email.";
export const LOOK_AGAIN_LINE = "This bot's email changed since you looked. Look again, then choose.";
/** Shown when the server's home view is not in a shape this app reads. Never an empty list. */
export const VIEW_UNSUPPORTED_LINE = "This list could not be read. Nothing changed. Try again in a minute.";
export const VIEW_LOAD_FAILED_LINE = "Email addresses could not be loaded. Try again.";

/** The refusal codes the draft names for each decision (invariants.ts KEEP_REFUSALS, REMOVE_REFUSALS, WINDOW_REFUSAL_CODES). */
export const KEEP_REFUSAL_CODES = ["removal_sending", "keep_pending", "confirm_expired", "inbox_gone", "bot_present", "restore_finishing"] as const;
export const REMOVE_REFUSAL_CODES = ["keep_pending", "confirm_expired", "bot_present", "restore_finishing"] as const;

/** Every action a row can offer. */
export type DecisionAction = "keep" | "remove" | "try_again_now" | "confirm_inventory";
/** Shown on a row whose action the server sent with a path this app will not use. */
export const ACTION_UNAVAILABLE_LINE = "This choice is not available right now. Nothing changed. Try again in a minute.";

export interface RefusalContext {
  action: DecisionAction;
  /** A Keep from a bot row sent no token: only that one can be refused because the binding changed (LOOK_AGAIN_LINE). */
  untokenedBotKeep: boolean;
}

/** The owner line for a refused Keep or Remove. Any string the server sent in `error` is returned exactly as given (empty and
 *  whitespace-only included) BEFORE the code is consulted. The fallback copy is for a refusal that carried no string. LOOK_AGAIN_LINE
 *  is the fallback of the untokened bot-row Keep only; a Remove never falls back to it. */
export function refusalLine(refusal: { code: string; error?: string | null }, context: RefusalContext): string {
  if (typeof refusal.error === "string") return refusal.error;
  const { action } = context;
  if (action !== "keep" && action !== "remove" && refusal.code !== "restore_finishing") return "Nothing changed. Try again in a minute.";
  switch (refusal.code) {
    case "restore_finishing": return RESTORE_FINISHING_LINE;
    case "confirm_expired": return action === "keep" && context.untokenedBotKeep ? LOOK_AGAIN_LINE : "Nothing changed. Look again, then choose.";
    case "removal_sending": return "This email is being removed right now. Nothing changed. Try Keep again in a minute.";
    case "keep_pending": return action === "keep"
      ? "Your Keep for this email is still going through. Nothing changed. Check again in a minute."
      : "Your Keep for this email is still going through, so it was not removed. Nothing changed. Try again in a minute.";
    case "inbox_gone": return "This email address is already gone, so there is nothing to keep. The list will update.";
    case "bot_present": return action === "keep"
      ? "A bot is using this email now, so there is nothing to keep here. Nothing changed."
      : "A bot is using this email now, so it was not removed. Nothing changed. Remove the bot first if you want it gone.";
    default: return "Nothing changed. Try again in a minute.";
  }
}

/** The restore result's kept addresses: at most five, then "and N more". */
export const KEPT_SHOWN = 5;
export function keptSummary(addresses: readonly string[]): { shown: string[]; more: string | null } {
  const shown = addresses.slice(0, KEPT_SHOWN);
  const rest = addresses.length - shown.length;
  return { shown, more: rest > 0 ? `and ${rest} more` : null };
}

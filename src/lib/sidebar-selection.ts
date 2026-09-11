// Adapted from OpenMausBot (Apache-2.0): PR #762 production commit
// 03d9fb3f4942259ecac44d7d94571bb53260d894 and PR #767 production commit
// 2eb4c7c5d32c85d8e0ae3e43d7f7861e81c2977f. Murage keeps its own role rules
// (Chief of Staff, team lead, last active bot) and More-actions control.
import type { botRole } from "@/lib/bot-role";

/** Keep the whole bot row selectable while its inline name editor is open.
 * The rename input owns its own clicks; the avatar, body and right edge
 * still open the bot.
 *
 * Murage adaptation: while renaming, the press itself blurs the field, which
 * commits the name and re-renders the row. Pressing the avatar was observed to
 * replace the SVG node under the pointer before mouseup, and Chromium then
 * delivers no click, so a primary press outside the field selects on
 * mousedown instead. */
export function botListItemPointerIntent(type: string, insideRenameInput = false, renaming = false, button = 0): "select" | "ignore" {
  if (insideRenameInput) return "ignore";
  if (type === "click") return "select";
  return type === "mousedown" && renaming && button === 0 ? "select" : "ignore";
}

/** Whether a click target sits inside the row's rename field. */
export function insideRenameField(target: EventTarget | null): boolean {
  return typeof Element !== "undefined" && target instanceof Element && target.closest("input") !== null;
}

/** The inline Archive shortcut exists only when archiving can happen. A
 * disabled button still owns its pixels in Chromium, even at zero opacity, so
 * an unavailable action is omitted and those pixels select the row instead.
 * The Chief of Staff and team leads need a successor first, the last active
 * bot cannot be archived, and a row being renamed keeps its right edge. */
export function inlineArchiveAvailable(state: {
  role: ReturnType<typeof botRole>;
  archiveDisabled: boolean;
  renaming: boolean;
  iconOnly: boolean;
}): boolean {
  return state.role !== "chief" && state.role !== "leader" && !state.archiveDisabled && !state.renaming && !state.iconOnly;
}

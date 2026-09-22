// The open conversation's row in the sidebar.
//
// A faint fill plus a hairline border was too quiet to find at a glance. The
// selected row carries an ink edge, doubled by an inset shadow so the edge
// thickens without the box growing. A team lead's outline is
// blue and the Chief keeps its orange tint underneath. Unread used to be an
// orange dot here; it is the name's weight now, because a mark that fires on
// unread is on nearly every row and therefore means nothing.
//
// COLOUR IS SPENT ON MEANING, AND SELECTION IS NOT MEANING.
//
// The selected edge used to be drawn in the warning token, which is the same
// token `sidebarMarkRowClass` fills a WAITING row with and the same one every
// warning callout in the app uses. An earlier version of this comment claimed
// gold was deliberately none of the other row signals. It was not, and a
// comment asserting a safety property the code does not have is worse than
// none.
//
// The fix is to move the selection rather than the mark, because amber is
// carrying information ("this bot is waiting on you") and selection is
// carrying navigation state. Ink is not a signal colour, so it cannot be read
// as waiting, as a team lead, or as the Chief, and it is near-white on dark
// and near-black on light, so it is legible in both.
//
// AND IT HAS TO BE LOUD. The treatment before gold was a faint fill plus a
// hairline border and it was too quiet to find at a glance, which is the
// reason a signal colour got borrowed in the first place. Hairline is #4d4d4d
// against a #2a2a2a row; ink is #f5f5f5. The inset shadow thickens the edge
// without changing the box, so nothing shifts by a pixel when a row is
// selected.
import type { botRole } from "@/lib/bot-role";

export const SIDEBAR_SELECTED_ROW = "border-ink shadow-[inset_0_0_0_1px_var(--color-ink)]";

type Role = ReturnType<typeof botRole>;

export function sidebarBotRowTone(role: Role, selected: boolean): string {
  if (role === "chief") {
    return selected ? `${SIDEBAR_SELECTED_ROW} bg-accent/15` : "border-accent/25 bg-accent/5 hover:bg-accent/10";
  }
  if (role === "leader") {
    return selected ? `${SIDEBAR_SELECTED_ROW} bg-raised` : "border-team-lead/30 hover:bg-raised/50";
  }
  return selected ? `${SIDEBAR_SELECTED_ROW} bg-raised` : "border-transparent hover:bg-raised/50";
}

/** Channel rows had no border at all; a transparent one at rest keeps the
 *  selected edge from shifting the row by a pixel. */
export function sidebarGroupRowTone(selected: boolean): string {
  return selected ? `border ${SIDEBAR_SELECTED_ROW} bg-raised` : "border border-transparent hover:bg-raised/50";
}

export function sidebarNavRowTone(selected: boolean): string {
  return selected ? `border ${SIDEBAR_SELECTED_ROW} bg-raised text-ink` : "border border-transparent text-ink hover:bg-raised/50";
}

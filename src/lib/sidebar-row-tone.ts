// The open conversation's row in the sidebar.
//
// A faint fill plus a hairline border was too quiet to find at a glance. The
// selected row now carries a gold edge in the warning token (#fbbf24 dark,
// #8a6100 light — both clear of the panel ground), doubled by an inset shadow
// so the edge thickens without the box growing. A team lead's outline is
// blue and the Chief keeps its orange tint underneath. Unread used to be an
// orange dot here; it is the name's weight now, because a mark that fires on
// unread is on nearly every row and therefore means nothing.
//
// THIS SHARES A HUE WITH "WAITING FOR YOU" AND THAT IS NOT YET DECIDED.
// An earlier version of this comment claimed gold was deliberately none of
// the other row signals. It is not: sidebarMarkRowClass backs a waiting row
// with bg-warning/10 and the selected edge is --color-warning too. They
// differ by PROPERTY rather than by colour — an edge against a fill, and
// only the waiting row carries a dot and says "Waiting for you" out loud —
// so they are told apart today. Claiming they were different colours was
// simply wrong, and a comment asserting a safety property the code does not
// have is worse than no comment at all. If the two are ever separated
// properly, the SELECTED edge is the one to move: the waiting amber is
// load-bearing and the selection is not.
import type { botRole } from "@/lib/bot-role";

export const SIDEBAR_SELECTED_ROW = "border-warning shadow-[inset_0_0_0_1px_var(--color-warning)]";

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

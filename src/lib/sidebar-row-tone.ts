// The open conversation's row in the sidebar.
//
// A faint fill plus a hairline border was too quiet to find at a glance. The
// selected row carries a GOLD edge in the warning token (#fbbf24 dark,
// #8a6100 light), doubled by an inset shadow so the edge thickens without the
// box growing. A team lead's outline is blue and the Chief keeps its orange
// tint underneath. Unread used to be an orange dot here; it is the name's
// weight now, because a mark that fires on unread is on nearly every row and
// therefore means nothing.
//
// IT SHARES A TOKEN WITH "WAITING FOR YOU", AND THAT IS A DECISION.
//
// An older comment here claimed gold was deliberately none of the other row
// signals. That was simply false: sidebarMarkRowClass fills a waiting row
// with bg-warning/10 and every warning callout in the app uses the same
// token. The claim was removed, and then the selection was moved to ink to
// make the claim true.
//
// THAT WAS THE WRONG TRADE AND THE OWNER SAID SO. Nobody had ever confused
// the two, no defect was ever reported, and gold selection is the look of his
// product. An invariant invented to satisfy a comment is not worth the cost
// of a theme he chose.
//
// WHAT KEEPS THEM APART IS NOT COLOUR, and never really was. Selection is an
// EDGE; waiting is a FILL, and it additionally carries an amber dot, the
// words "Waiting for you" out loud (sidebarMarkLabel) and the name in full
// weight. Four differences, only one of which is hue. The test below pins the
// three that are not, so a future change that quietly drops the dot or the
// label has to argue with something.
//
// If the two ever DO get confused in real use, move the selection and not the
// mark: amber is carrying information and selection is carrying navigation
// state.
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

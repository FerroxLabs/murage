/** What happens to the Chief of Staff who hands the role over.
 *
 * One rule, read by the harness (server/store.ts), the optimistic reducer
 * (src/state/store.tsx) and the role control's note, so the three can never
 * describe different outcomes.
 *
 * The former Chief stays on as the leader of its own team when it can: its
 * engine has to be able to contact the bots it leads, and its team must not
 * already have a leader (one per team). Otherwise it joins that team as a
 * member. It is never dropped from the workspace. */
export interface HandoverBot {
  id: string;
  section?: string;
  chiefOfStaff?: boolean;
  chiefScope?: "workspace";
}

export function formerChiefOutcome(
  former: HandoverBot,
  bots: readonly HandoverBot[],
  canLead: boolean,
): "leader" | "member" {
  if (!canLead) return "member";
  const team = former.section?.trim() || "";
  const teamHasLeader = bots.some(
    (other) =>
      other.id !== former.id &&
      other.chiefOfStaff === true &&
      other.chiefScope !== "workspace" &&
      (other.section?.trim() || "") === team,
  );
  return teamHasLeader ? "member" : "leader";
}

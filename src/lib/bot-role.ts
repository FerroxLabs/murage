/** The org chart, as one word per bot.
 *
 * The harness stores the chart as three optional fields that only make sense
 * read together — `chiefOfStaff` says "leads something", `chiefScope` says
 * "leads the whole workspace", `individual` says "leads nothing and reports
 * straight to the Chief". Every surface that shows a role was reading the
 * first field alone, which is why a Team Leader and the Chief of Staff wore
 * the same pill and an Individual Assistant wore none at all.
 *
 * Kept deliberately free of React and of the store's `Bot` type so the four
 * places that render a role (chat header, sidebar, team map, agent profile)
 * and their tests can all share exactly one definition. */
export type BotRole = "chief" | "leader" | "individual" | "member";

/** The three fields the chart is made of. Structural on purpose: wire bots,
 * team-map bots and sidebar rows are all different types over the same
 * fields. */
export interface RoleBot {
  section?: string;
  chiefOfStaff?: boolean;
  chiefScope?: "workspace";
  individual?: boolean;
}

/** Where this bot sits. The Chief role wins over `individual` when a record
 * somehow carries both — the same tie-break the harness applies at load, so
 * the renderer can never disagree with the server about who leads what. */
export function botRole(bot: RoleBot): BotRole {
  if (bot.chiefOfStaff) return bot.chiefScope === "workspace" ? "chief" : "leader";
  return bot.individual ? "individual" : "member";
}

/** Badge text. A team member wears nothing — being on a team is the default,
 * and a badge on every row would tell the eye nothing. */
export const BOT_ROLE_BADGE: Record<BotRole, string> = {
  chief: "Chief of Staff",
  leader: "Team lead",
  individual: "Individual",
  member: "",
};

export const BOT_ROLE_TITLE: Record<BotRole, string> = {
  chief: "Chief of Staff",
  leader: "Team leader",
  individual: "Individual assistant",
  member: "Team member",
};

/** The PATCH body that moves a bot to `role`.
 *
 * Every field is always sent, never only the ones that changed: the harness
 * refuses `individual: true` alongside a Chief role, and the only way to be
 * sure the two never travel together is to state both in the same request.
 * `chiefTier` reaches the wire as `chiefScope` and never folds into bot
 * state — "section" and null both mean "drop the workspace tier", which the
 * store spells as an absent field. */
export function botRolePatch(role: BotRole): {
  chiefOfStaff: boolean;
  chiefTier: "workspace" | "section" | null;
  individual: boolean;
} {
  return {
    chiefOfStaff: role === "chief" || role === "leader",
    chiefTier: role === "chief" ? "workspace" : role === "leader" ? "section" : null,
    individual: role === "individual",
  };
}

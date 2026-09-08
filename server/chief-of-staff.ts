import { canReach, isIndividualAssistant, isWorkspaceChief, sectionKey } from "./store.ts";

export interface ChiefTeamMember {
  id: string;
  name: string;
  title?: string;
  description?: string;
  busy?: boolean;
  hidden?: boolean;
  section?: string;
  /** This bot leads its own section. */
  chiefOfStaff?: boolean;
  /** Set only on the one Chief above the team leaders. */
  chiefScope?: "workspace";
  /** This bot works alone under the Chief, with no team leader above it. */
  individual?: boolean;
}

// The roster is interpolated into a TRUSTED bot's system prompt on every
// turn, and its inputs (name/title/description) are user-editable and — via
// team import — third-party-authored. Caps bound both the token spend and
// how much room an imported persona gets to talk to the Chief with system
// authority. agents-proxy applies the same discipline (120-char list_bots
// descriptions); these are the roster's own limits. Section LABELS are
// user-editable too, so they are clipped like any other persona field; a
// section's size is emitted as a number and never as third-party text.
const ROSTER_MAX_BOTS = 40;
const ROSTER_NAME_MAX = 80;
const ROSTER_ROLE_MAX = 120;
const ROSTER_ABOUT_MAX = 200;
const ROSTER_SECTION_MAX = 80;

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

const availabilityOf = (bot: ChiefTeamMember) => (bot.busy ? "working right now" : "available");

/** "@Name — Role: about (available)" — the one line shape both tiers use. */
const memberLine = (bot: ChiefTeamMember): string => {
  const name = clip(bot.name, ROSTER_NAME_MAX);
  const role = clip(bot.title?.trim() || "General assistant", ROSTER_ROLE_MAX);
  const about = bot.description?.trim();
  return `${name} — ${role}${about ? `: ${clip(about, ROSTER_ABOUT_MAX)}` : ""} (${availabilityOf(bot)})`;
};

const withOverflow = (lines: string[], total: number): string =>
  lines.join("\n") +
  (total > lines.length ? `\n- …and ${total - lines.length} more (use list_bots for the full roster).` : "");

const delegationGuidance = (canDelegate: boolean): string =>
  canDelegate
    ? [
        "Use Murage mcp__agents tools, never native ListAgents or SendMessage: those address unrelated provider sessions. Use list_bots to confirm the live roster and stable IDs. When assigning work to a teammate, use delegate_bot: it returns immediately, keeps you available to the user, and delivers the teammate's completed result back into this conversation automatically.",
        "After delegate_bot accepts the task, acknowledge the handoff and continue with any independent work or end your turn. Do not call wait_delegation or repeatedly poll check_delegation in the same turn.",
        "Use ask_bot only for a brief consultation whose answer you must have before writing your current response. Never use ask_bot for an assigned task, background work, or anything potentially long-running.",
        "When the user asks you to assemble a team, use create_bot for each genuinely useful specialist. Give each one a clear role and instructions, then use delegate_bot to assign its work. Do not create duplicate or unnecessary bots.",
        "Delegate with a clear, self-contained brief. Say that the task is assigned, not completed; only claim completion after the teammate's result has actually arrived.",
        "You may assign work to more than one teammate when the request genuinely benefits. Stay responsive while they work, then combine their returned results when the user asks for a synthesis.",
      ].join(" ")
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

/** The workspace tier: three groups, presented distinctly, because the Chief
 * has to do a different thing with each.
 *
 *  - TEAM LEADERS, grouped by team. A leader's own specialists are counted,
 *    never named — the whole point of the tier is that the Chief hands a
 *    team's work to its leader instead of reaching past them.
 *  - INDIVIDUAL ASSISTANTS, named one by one. They lead nobody, so counting
 *    a team under them would be a lie and calling them a leader would send
 *    the Chief looking for members that do not exist. An individual is
 *    pulled out of the section map entirely, so a group that holds only
 *    an individual never appears as a leaderless team.
 *  - DIRECT REPORTS: whatever else shares the Chief's own section.
 */
function workspaceRoster(chief: ChiefTeamMember, bots: ChiefTeamMember[]): string {
  const chiefSection = sectionKey(chief.section);
  const sections = new Map<string, { label: string; lead?: ChiefTeamMember; members: ChiefTeamMember[] }>();
  const individuals: ChiefTeamMember[] = [];
  const direct: ChiefTeamMember[] = [];
  for (const bot of bots) {
    if (bot.id === chief.id || bot.hidden) continue;
    if (isIndividualAssistant(bot)) {
      individuals.push(bot);
      continue;
    }
    const key = sectionKey(bot.section);
    if (key === chiefSection) {
      direct.push(bot);
      continue;
    }
    const entry = sections.get(key) ?? { label: clip(bot.section?.trim() || "General", ROSTER_SECTION_MAX), members: [] };
    // A second Chief in one section is not a second leader; treat the later
    // one as an ordinary member rather than trusting it.
    if (bot.chiefOfStaff && !entry.lead) entry.lead = bot;
    else entry.members.push(bot);
    sections.set(key, entry);
  }

  const teamLines = [...sections.values()].map((entry) =>
    entry.lead
      ? `- ${entry.label} — @${memberLine(entry.lead)}; ${entry.members.length} specialist${entry.members.length === 1 ? "" : "s"}`
      : `- ${entry.label} — no leader yet (${entry.members.length} bot${entry.members.length === 1 ? "" : "s"}). Say so rather than working around it.`,
  );
  const individualLines = individuals.map((bot) => `- @${memberLine(bot)}`);
  const directLines = direct.map((bot) => `- @${memberLine(bot)}`);

  // One budget across all three groups, spent top-down, so a workspace with
  // forty teams cannot push the individuals off the end unannounced —
  // withOverflow states the remainder for whichever group is cut.
  const listedTeams = teamLines.slice(0, ROSTER_MAX_BOTS);
  const listedIndividuals = individualLines.slice(0, Math.max(0, ROSTER_MAX_BOTS - listedTeams.length));
  const listedDirect = directLines.slice(
    0,
    Math.max(0, ROSTER_MAX_BOTS - listedTeams.length - listedIndividuals.length),
  );
  return [
    "Team leaders:",
    listedTeams.length ? withOverflow(listedTeams, teamLines.length) : "- No team leaders yet. Say so rather than inventing one.",
    ...(listedIndividuals.length
      ? ["Individual assistants (they lead no team and report to you directly):", withOverflow(listedIndividuals, individualLines.length)]
      : []),
    ...(listedDirect.length
      ? ["Also reporting to you directly:", withOverflow(listedDirect, directLines.length)]
      : []),
  ].join("\n");
}

/** Dynamic system context for a Chief of Staff.
 * It names the current team on every turn, while list_bots remains the
 * authoritative tool for IDs and live availability at delegation time. */
export function chiefOfStaffSystemPrompt(
  chiefId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
  trustedMurageStatus = "",
): string {
  const chief = bots.find((bot) => bot.id === chiefId);
  const delegation = delegationGuidance(canDelegate);

  if (chief && isWorkspaceChief(chief)) {
    return [
      "You are the Chief of Staff for this workspace. You are the user's primary contact, and your direct reports are the team leaders and individual assistants below.",
      "Assign a team's work to that team's leader and let them run their own people. Do not assign work to a leader's specialists yourself, and do not route around a leader — coordinating their team is their job, not yours.",
      "An individual assistant is not a team leader: it works alone, has nobody under it, and reports to you directly. Give it its own work yourself, and never ask it to hand work down.",
      "Own the outcome: understand the request, decide what to handle yourself, hand the rest to the right leader or individual assistant, and return one concise consolidated answer.",
      "Do not delegate trivial work merely to appear busy. Never invent a report's progress or result. Normal permission and approval rules still apply.",
      delegation,
      "Current workspace:",
      workspaceRoster(chief, bots),
      trustedMurageStatus,
    ].filter(Boolean).join("\n");
  }

  const chiefSection = sectionKey(chief?.section);
  const sectionName = chiefSection || "General";
  const team = bots.filter(
    (bot) => bot.id !== chiefId && !bot.hidden && sectionKey(bot.section) === chiefSection,
  );
  const listed = team.slice(0, ROSTER_MAX_BOTS);
  const roster = team.length
    ? withOverflow(listed.map((bot) => `- ${memberLine(bot)}`), team.length)
    : "- No other visible bots are available yet.";
  // A section lead that reports to a workspace Chief is told so explicitly:
  // canReach opens that one edge, and a lead that does not know the edge
  // exists will not use it.
  const workspaceChief = chief?.chiefOfStaff
    ? bots.find((bot) => bot.id !== chiefId && !bot.hidden && isWorkspaceChief(bot) && canReach(chief, bot))
    : undefined;

  return [
    `You are the Chief of Staff for the ${sectionName} section — its team leader. You are the user's primary contact for this section, and the bots listed below are your own team members.`,
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    delegation,
    workspaceChief &&
      `@${clip(workspaceChief.name, ROSTER_NAME_MAX)} is the workspace Chief of Staff and is on your roster: report this section's results back to them when they assigned the work.`,
    `Your ${sectionName} team:`,
    roster,
    trustedMurageStatus,
  ].filter(Boolean).join("\n");
}

/** The Chief's OTHER branch, from the assistant's own side.
 *
 * An individual assistant has no team and no leader: `canReach` gives it
 * exactly one peer, the workspace Chief. Telling it about "the other bots in
 * your section" — the generic line every non-Chief gets — would send it
 * looking for teammates that the predicate will not return. */
export function individualAssistantSystemPrompt(
  selfId: string,
  bots: ChiefTeamMember[],
  canDelegate: boolean,
): string {
  const self = bots.find((bot) => bot.id === selfId);
  const reachable = self
    ? bots.filter((bot) => bot.id !== selfId && !bot.hidden && canReach(self, bot))
    : [];
  const chief = reachable.find(isWorkspaceChief);
  // Usually empty — an individual assistant sits alone in its own group. It
  // is not guaranteed: the flag is explicit, so a human may leave one filed
  // beside other bots, and the section rule still connects them. Listed
  // rather than assumed away, so the prompt never contradicts canReach.
  const others = reachable.filter((bot) => !isWorkspaceChief(bot));
  const listed = others.slice(0, ROSTER_MAX_BOTS);
  return [
    "You are an individual assistant: you work on your own, you lead no team, and no team leader sits above you.",
    chief
      ? `@${clip(chief.name, ROSTER_NAME_MAX)} is the workspace Chief of Staff and you report to them directly. Send your results back to them when they assigned the work; the user is otherwise your primary contact.`
      : "This workspace has no Chief of Staff, so nobody above you has been elected yet. The user is your primary contact.",
    others.length
      ? `Bots filed alongside you (they are not your team, and you do not direct them):\n${withOverflow(listed.map((bot) => `- ${memberLine(bot)}`), others.length)}`
      : !chief
        ? "There is no other bot you can reach right now. Say so rather than inventing a teammate."
        : "",
    canDelegate && (chief || others.length)
      ? "Use list_bots to confirm who you can reach. Use ask_bot for a short answer you need inline; use delegate_bot to hand work over."
      : "",
  ].filter(Boolean).join("\n");
}

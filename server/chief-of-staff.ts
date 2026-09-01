import { canReach, isWorkspaceChief, sectionKey } from "./store.ts";

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
  /** Set only on the one Chief above the section leads. */
  chiefScope?: "workspace";
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
        "Use list_bots to confirm the live roster and IDs. When assigning work to a teammate, use delegate_bot: it returns immediately, keeps you available to the user, and delivers the teammate's completed result back into this conversation automatically.",
        "After delegate_bot accepts the task, acknowledge the handoff and continue with any independent work or end your turn. Do not call wait_delegation or repeatedly poll check_delegation in the same turn.",
        "Use ask_bot only for a brief consultation whose answer you must have before writing your current response. Never use ask_bot for an assigned task, background work, or anything potentially long-running.",
        "When the user asks you to assemble a team, use create_bot for each genuinely useful specialist. Give each one a clear role and instructions, then use delegate_bot to assign its work. Do not create duplicate or unnecessary bots.",
        "Delegate with a clear, self-contained brief. Say that the task is assigned, not completed; only claim completion after the teammate's result has actually arrived.",
        "You may assign work to more than one teammate when the request genuinely benefits. Stay responsive while they work, then combine their returned results when the user asks for a synthesis.",
      ].join(" ")
    : "Your current engine cannot contact teammates. Be honest about that limitation and ask the user to choose a delegation-compatible engine before promising coordinated work.";

/** The workspace tier: the roster is the section LEADS, grouped by team, plus
 * whatever reports to the Chief directly. A lead's own specialists are
 * counted, never named — the whole point of the tier is that the Chief hands
 * a team's work to its lead instead of reaching past them. */
function workspaceRoster(chief: ChiefTeamMember, bots: ChiefTeamMember[]): string {
  const chiefSection = sectionKey(chief.section);
  const sections = new Map<string, { label: string; lead?: ChiefTeamMember; members: ChiefTeamMember[] }>();
  for (const bot of bots) {
    if (bot.id === chief.id || bot.hidden) continue;
    const key = sectionKey(bot.section);
    const entry = sections.get(key) ?? { label: clip(bot.section?.trim() || "General", ROSTER_SECTION_MAX), members: [] };
    // A Chief in the workspace Chief's OWN section would be a second chief
    // of one section; treat it as an ordinary report rather than trusting it.
    if (bot.chiefOfStaff && key !== chiefSection && !entry.lead) entry.lead = bot;
    else entry.members.push(bot);
    sections.set(key, entry);
  }

  const teamEntries = [...sections].filter(([key]) => key !== chiefSection);
  const teamLines = teamEntries.map(([, entry]) =>
    entry.lead
      ? `- ${entry.label} — @${memberLine(entry.lead)}; ${entry.members.length} specialist${entry.members.length === 1 ? "" : "s"}`
      : `- ${entry.label} — no lead yet (${entry.members.length} bot${entry.members.length === 1 ? "" : "s"}). Say so rather than working around it.`,
  );
  const directLines = (sections.get(chiefSection)?.members ?? []).map((bot) => `- @${memberLine(bot)}`);

  const listedTeams = teamLines.slice(0, ROSTER_MAX_BOTS);
  const listedDirect = directLines.slice(0, Math.max(0, ROSTER_MAX_BOTS - listedTeams.length));
  return [
    "Section leads:",
    listedTeams.length ? withOverflow(listedTeams, teamLines.length) : "- No section leads yet. Say so rather than inventing one.",
    ...(listedDirect.length
      ? ["Reporting to you directly:", withOverflow(listedDirect, directLines.length)]
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
      "You are the Chief of Staff for this workspace. You are the user's primary contact, and your direct reports are the section leads below.",
      "Assign a team's work to that team's lead and let them run their own people. Do not assign work to a lead's specialists yourself, and do not route around a lead — coordinating their team is their job, not yours.",
      "Own the outcome: understand the request, decide what to handle yourself, hand the rest to the right lead, and return one concise consolidated answer.",
      "Do not delegate trivial work merely to appear busy. Never invent a lead's progress or result. Normal permission and approval rules still apply.",
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
    `You are the Chief of Staff for the ${sectionName} section. You are the user's primary contact for this section's team of bots.`,
    "Own the outcome: understand the request, decide what to handle yourself, coordinate the right specialists when useful, and return one concise consolidated answer.",
    "Do not delegate trivial work merely to appear busy. Never invent a teammate's progress or result. Normal permission and approval rules still apply.",
    delegation,
    workspaceChief &&
      `@${clip(workspaceChief.name, ROSTER_NAME_MAX)} is the workspace Chief of Staff and is on your roster: report this section's results back to them when they assigned the work.`,
    `Current ${sectionName} section team:`,
    roster,
    trustedMurageStatus,
  ].filter(Boolean).join("\n");
}

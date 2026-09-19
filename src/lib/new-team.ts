// New Team: name a team, choose its bots, optionally pick a lead and write
// its instructions — the pieces the sidebar already has, gathered into one
// dialog so a person never has to find "Move to team…" on each bot first.
//
// A team is a sidebar section. It is not a stored resource: it exists while a
// bot or channel carries its name, which is why the dialog needs at least one
// bot. Filing goes through `POST /api/sidebar-sections` (the same route a bot
// dropped on a team uses), the lead through the same role PATCH as the bot
// menu's "Make Team leader", and the instructions through the same
// `/api/section-context` call as the team header's editor.
import { botRole, type BotRole, type RoleBot } from "./bot-role";

/** Sidebar headings that are not teams. A team with one of these names would
 * read as the heading it copies. */
export const RESERVED_TEAM_NAMES = ["General", "Bots", "Channels", "Bot Chats", "Pinned"] as const;

export const TEAM_NAME_MAX = 60;

/** What the bot menu says when a bot's engine cannot lead a team. */
export const LEADERSHIP_BLOCKED_HINT = "Choose an engine with Murage delegation support first";

/** Leading a team means delegating, so a bot whose engine cannot delegate is
 * not offered the role. Stepping down is always allowed. */
export function leadershipPromotionBlocked(role: BotRole, canCoordinate: boolean): boolean {
  return role !== "chief" && role !== "leader" && !canCoordinate;
}

export interface NewTeamBot extends RoleBot {
  id: string;
  name: string;
  hidden?: boolean;
}

/** Every team name in the sidebar, as it is written there. */
export function existingTeamNames(
  bots: readonly { hidden?: boolean; section?: string }[],
  groups: readonly { section?: string }[],
): string[] {
  return [
    ...new Set(
      [...bots.filter((bot) => !bot.hidden).map((bot) => bot.section), ...groups.map((group) => group.section)]
        .map((section) => section?.trim() ?? "")
        .filter(Boolean),
    ),
  ];
}

/** The bots a new team can be made of. The Chief of Staff sits above every
 * team rather than in one, the same rule a sidebar drag follows. */
export function teamCandidates<T extends NewTeamBot>(bots: readonly T[]): T[] {
  return bots.filter((bot) => !bot.hidden && botRole(bot) !== "chief");
}

export interface NewTeamDraft {
  name: string;
  botIds: readonly string[];
}

/** Why this draft cannot be created yet, in words for the person, or null. */
export function newTeamProblem(
  draft: NewTeamDraft,
  bots: readonly NewTeamBot[],
  existing: readonly string[],
): string | null {
  const name = draft.name.trim();
  if (!name) return "Give the team a name.";
  if (name.length > TEAM_NAME_MAX) return `Team names can be up to ${TEAM_NAME_MAX} characters.`;
  const folded = name.toLocaleLowerCase();
  const reserved = RESERVED_TEAM_NAMES.find((candidate) => candidate.toLocaleLowerCase() === folded);
  if (reserved) return `"${reserved}" is already a heading in the sidebar. Choose another name.`;
  const taken = existing.find((candidate) => candidate.trim().toLocaleLowerCase() === folded);
  if (taken) return `There is already a team called ${taken}. To add bots to it, use Move to team… on each bot.`;
  if (draft.botIds.length === 0) return "Choose at least one bot. A team shows in the sidebar while it has a bot in it.";
  const leads = bots.filter((bot) => draft.botIds.includes(bot.id) && botRole(bot) === "leader");
  if (leads.length > 1) {
    const names = leads.map((bot) => bot.name);
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} each lead a team, and a team can have only one lead. Untick all but one of them.`;
  }
  return null;
}

/** The lead the dialog shows before the person chooses: a chosen bot that
 * already leads a team keeps leading, since moving it here moves its role. */
export function defaultTeamLead(botIds: readonly string[], bots: readonly NewTeamBot[]): string {
  return bots.find((bot) => botIds.includes(bot.id) && botRole(bot) === "leader")?.id ?? "";
}

export interface CreateTeamInput {
  name: string;
  botIds: readonly string[];
  /** "" for no lead */
  leadId: string;
  instructions: string;
}

export interface CreateTeamDeps<T> {
  request: (path: string, init: { method: string; body: string }) => Promise<unknown>;
  /** Fold the harness's answer for the filed bots into the store. */
  applyBots: (bots: T[]) => void;
  /** The bot menu's role change, applied through the same queued PATCH. */
  setRole: (botId: string, role: "leader" | "member") => void;
  saveInstructions: (section: string, text: string) => Promise<unknown>;
}

export type CreateTeamResult =
  | { ok: true; section: string; text: string; error?: undefined }
  | { ok: true; section: string; text: string; error: string }
  | { ok: false; error: string };

/** File the bots, then set the lead, then save the instructions. Filing is
 * the step that makes the team exist, so if it fails nothing else is tried;
 * a later step's failure is reported with what did apply. */
export async function createTeam<T extends NewTeamBot>(
  input: CreateTeamInput,
  bots: readonly T[],
  deps: CreateTeamDeps<T>,
): Promise<CreateTeamResult> {
  const name = input.name.trim();
  let section = name;
  try {
    const response = (await deps.request("/api/sidebar-sections", {
      method: "POST",
      body: JSON.stringify({ name, botIds: [...input.botIds] }),
    })) as { section: string; bots: T[] };
    section = response.section;
    deps.applyBots(response.bots);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }

  const chosen = bots.filter((bot) => input.botIds.includes(bot.id));
  if (input.leadId) {
    const lead = chosen.find((bot) => bot.id === input.leadId);
    if (lead && botRole(lead) !== "leader") deps.setRole(lead.id, "leader");
  } else {
    // "No lead" is a choice: a bot that led its old team stops leading here.
    for (const bot of chosen) if (botRole(bot) === "leader") deps.setRole(bot.id, "member");
  }

  const count = chosen.length || input.botIds.length;
  const text = `${section} created with ${count} ${count === 1 ? "bot" : "bots"}`;
  if (input.instructions.trim()) {
    try {
      await deps.saveInstructions(section, input.instructions);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return {
        ok: true,
        section,
        text,
        error: `${text}, but its instructions were not saved (${reason}). Open them from the team's heading to try again.`,
      };
    }
  }
  return { ok: true, section, text };
}

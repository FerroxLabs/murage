// Dragging a bot row onto a team in the sidebar.
//
// A team is a sidebar section, and a bot joins one through the harness's
// section-filing route (`POST /api/sidebar-sections`). That route is the one
// that refuses to seat a second lead in a team, so a drag can never quietly
// demote somebody — the "Move to section" menu's PATCH hands leadership over
// instead, which is an explicit role change and stays behind that menu.
import { botRole, type RoleBot } from "./bot-role";
import { BOTS_SECTION_ID, userSectionName, type SidebarSectionId } from "./sidebar-layout";

/** Distinct from the section-reorder drag type, so a bot dropped between two
 *  sections never reorders them and a section never files itself as a bot. */
export const SIDEBAR_BOT_DRAG_TYPE = "application/x-murage-sidebar-bot";

export interface SidebarDropBot extends RoleBot {
  id: string;
  name: string;
  hidden?: boolean;
}

export type SidebarBotDropPlan = { kind: "team"; section: string } | { kind: "general" };

export type SidebarBotMoveResult<T> =
  | { ok: true; bots: T[]; text: string }
  | { ok: false; error: string };

const isWorkspaceChief = (bot: SidebarDropBot) => botRole(bot) === "chief";

/** The workspace Chief of Staff sits above every team, not in one. */
export function sidebarBotDraggable(bot: SidebarDropBot): boolean {
  return !bot.hidden && !isWorkspaceChief(bot);
}

/** What dropping `bot` on the section `targetId` would do, or null when that
 *  section is not a place a bot can be filed (Pinned is a per-bot flag with
 *  its own menu action; Channels and Bot Chats hold conversations). */
export function planSidebarBotDrop(bot: SidebarDropBot, targetId: SidebarSectionId): SidebarBotDropPlan | null {
  if (!sidebarBotDraggable(bot)) return null;
  const current = bot.section?.trim() ?? "";
  const team = userSectionName(targetId)?.trim();
  if (team) return team === current ? null : { kind: "team", section: team };
  if (targetId !== BOTS_SECTION_ID || !current) return null;
  // Leaving a team for Bots goes through PATCH, which would make a lead the
  // lead of Bots and demote whoever holds that today. Not by drag.
  return botRole(bot) === "leader" ? null : { kind: "general" };
}

type Request = (path: string, init: { method: string; body: string }) => Promise<unknown>;

export async function moveSidebarBot<T extends SidebarDropBot>(
  bot: SidebarDropBot,
  plan: SidebarBotDropPlan,
  request: Request,
): Promise<SidebarBotMoveResult<T>> {
  try {
    if (plan.kind === "team") {
      const response = (await request("/api/sidebar-sections", {
        method: "POST",
        body: JSON.stringify({ name: plan.section, botIds: [bot.id] }),
      })) as { section: string; bots: T[] };
      return { ok: true, bots: response.bots, text: `${bot.name} moved to ${response.section}` };
    }
    const response = (await request(`/api/bots/${bot.id}`, {
      method: "PATCH",
      body: JSON.stringify({ section: null }),
    })) as { bot: T };
    return { ok: true, bots: [response.bot], text: `${bot.name} moved to Bots` };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

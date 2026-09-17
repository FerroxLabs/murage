import { describe, expect, it, vi } from "vitest";

import {
  BOTS_SECTION_ID,
  BOT_CHATS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  userSectionId,
} from "./sidebar-layout";
import {
  SIDEBAR_BOT_DRAG_TYPE,
  moveSidebarBot,
  planSidebarBotDrop,
  sidebarBotDraggable,
} from "./sidebar-bot-drop";

const member = { id: "b1", name: "Scout", section: "Research" };
const lead = { id: "b2", name: "Lead", section: "Research", chiefOfStaff: true };
const chief = { id: "b3", name: "Chief", chiefOfStaff: true, chiefScope: "workspace" as const };

describe("sidebar bot drag", () => {
  it("uses its own data type so a bot is never mistaken for a section reorder", () => {
    expect(SIDEBAR_BOT_DRAG_TYPE).not.toBe("application/x-murage-sidebar-section");
  });

  it("lets members and team leads be dragged but keeps the workspace Chief of Staff above every team", () => {
    expect(sidebarBotDraggable(member)).toBe(true);
    expect(sidebarBotDraggable(lead)).toBe(true);
    expect(sidebarBotDraggable(chief)).toBe(false);
    expect(sidebarBotDraggable({ ...member, hidden: true })).toBe(false);
  });

  it("targets team sections and Bots, never Pinned, Channels or Bot Chats", () => {
    expect(planSidebarBotDrop(member, userSectionId("Operations"))).toEqual({ kind: "team", section: "Operations" });
    expect(planSidebarBotDrop(member, BOTS_SECTION_ID)).toEqual({ kind: "general" });
    for (const id of [PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID]) {
      expect(planSidebarBotDrop(member, id)).toBeNull();
    }
  });

  it("ignores a drop onto the team the bot is already in", () => {
    expect(planSidebarBotDrop(member, userSectionId(" Research "))).toBeNull();
    expect(planSidebarBotDrop({ id: "b4", name: "Loose" }, BOTS_SECTION_ID)).toBeNull();
  });

  it("does not let a team lead be dropped out of its team into Bots", () => {
    // Moving a lead out through PATCH would hand Bots' leadership over
    // silently. The menu's explicit role controls remain the way to do it.
    expect(planSidebarBotDrop(lead, BOTS_SECTION_ID)).toBeNull();
    expect(planSidebarBotDrop(chief, userSectionId("Operations"))).toBeNull();
  });
});

describe("moveSidebarBot", () => {
  it("files a bot dropped on a team header through the sidebar section API with the right ids", async () => {
    const moved = { ...member, section: "Operations" };
    const request = vi.fn().mockResolvedValue({ section: "Operations", bots: [moved] });

    const result = await moveSidebarBot(member, { kind: "team", section: "Operations" }, request);

    expect(request).toHaveBeenCalledTimes(1);
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/api/sidebar-sections");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "Operations", botIds: ["b1"] });
    expect(result).toEqual({ ok: true, bots: [moved], text: "Scout moved to Operations" });
  });

  it("surfaces the server's one-lead refusal and reports nothing moved", async () => {
    const refusal = "A team can have only one lead. Choose one, or file these bots under a team that has no lead yet.";
    const request = vi.fn().mockRejectedValue(Object.assign(new Error(refusal), { status: 409 }));

    const result = await moveSidebarBot(lead, { kind: "team", section: "Operations" }, request);

    expect(result).toEqual({ ok: false, error: refusal });
  });

  it("moves a member back to Bots with the same PATCH the Move to section menu sends", async () => {
    const moved = { ...member, section: undefined };
    const request = vi.fn().mockResolvedValue({ bot: moved });

    const result = await moveSidebarBot(member, { kind: "general" }, request);

    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/api/bots/b1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ section: null });
    expect(result).toEqual({ ok: true, bots: [moved], text: "Scout moved to Bots" });
  });
});

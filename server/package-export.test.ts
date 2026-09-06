import { describe, expect, it } from "vitest";

import { createBotPackageExport, getBotPackageExportSelectionCandidates, type BotPackageExportInput } from "./package-export.ts";
import type { BotRecord } from "./store.ts";

describe("package export", () => {
  function selectionFixture(): BotPackageExportInput {
    const bots = ["one", "two"].map((id, index): BotRecord => ({
      id, threadId: `private-thread-${id}`, name: "Lead", title: "Research", description: "Help", color: "green", notifications: true, unread: false,
      modelSelection: { instanceId: "private-engine", model: "private-model" }, resumeCursors: { engine: "private-session" }, createdAt: 1,
      autoApprove: true, alwaysAllow: ["private-grant"], cwd: "/private/path",
      playbooks: [{ key: "check", name: "Check", summary: "Review", triggers: ["check"], instructions: `Review item ${index}` }],
    }));
    return { name: "Selected crew", bots, groups: [{ id: "room", threadId: "private-room", name: "Room", memberIds: ["one", "two"], defaultResponder: { kind: "member", botId: "one" }, bulletin: "Review", unread: false, createdAt: 1 }],
      routines: ["one", "two"].map(id => ({ id: `routine-${id}`, botId: id, target: "bot", name: "Check", prompt: "Check task", runOn: "ember", enabled: true, schedule: { type: "once", at: 1 }, durationMinutes: 30, nextRunAt: 1, createdAt: 1, updatedAt: 1 })),
    };
  }

  it("selects bots, portable playbooks and routine IDs without changing collision keys or copying runtime state", () => {
    const input = selectionFixture();
    const candidates = getBotPackageExportSelectionCandidates(input);
    expect(candidates.bots.map(bot => bot.key)).toEqual(["lead", "lead-2"]);
    expect(candidates.playbooks.map(playbook => playbook.key)).toEqual(["check", "lead-2-check"]);
    expect(candidates.routines.map(routine => routine.key)).toEqual(["check", "check-2"]);
    const exported = createBotPackageExport({ ...input, selection: { botIds: ["two"], playbookKeys: ["lead-2-check"], routineIds: ["routine-two"] } });
    expect(exported.package.agents.map(bot => bot.key)).toEqual(["lead-2"]);
    expect(exported.package.agents[0].playbooks).toEqual(["lead-2-check"]);
    expect(exported.package.playbooks?.map(playbook => playbook.key)).toEqual(["lead-2-check"]);
    expect(exported.package.routines?.map(routine => routine.key)).toEqual(["check-2"]);
    expect(exported.package.routines?.[0]).toMatchObject({ agent: "lead-2", enabledAfterInstall: false });
    expect(exported.package.rooms?.[0]).toMatchObject({ members: ["lead-2"], defaultResponder: { kind: "mentions" } });
    expect(JSON.stringify(exported)).not.toMatch(/private-thread|private-engine|private-model|private-session|private-grant|private\/path|autoApprove|alwaysAllow|nextRunAt/);
  });

  it("treats explicit empty playbook/routine selections as none and refuses empty bots", () => {
    const input = selectionFixture();
    const exported = createBotPackageExport({ ...input, selection: { botIds: ["one"], playbookKeys: [], routineIds: [] } });
    expect(exported.package.playbooks).toBeUndefined();
    expect(exported.package.agents[0].playbooks).toBeUndefined();
    expect(exported.package.routines).toBeUndefined();
    expect(() => createBotPackageExport({ ...input, selection: { botIds: [], playbookKeys: [], routineIds: [] } })).toThrow("Select at least one bot");
    expect(createBotPackageExport(input).package.agents).toHaveLength(2);
    expect(createBotPackageExport(input).package.playbooks).toHaveLength(2);
    expect(createBotPackageExport(input).package.routines).toHaveLength(2);
  });

  it.each([
    { botIds: ["absent"], playbookKeys: [], routineIds: [] },
    { botIds: ["one", "one"], playbookKeys: [], routineIds: [] },
    { botIds: ["one"], playbookKeys: ["absent"], routineIds: [] },
    { botIds: ["one"], playbookKeys: ["lead-2-check"], routineIds: [] },
    { botIds: ["one"], playbookKeys: [], routineIds: ["routine-two"] },
    { botIds: ["one"], playbookKeys: [], routineIds: ["missing"] },
  ])("refuses unavailable, duplicate or unowned selections: %j", selection => {
    expect(() => createBotPackageExport({ ...selectionFixture(), selection })).toThrow();
  });

  it("reports unsupported room-goal candidates and refuses their explicit selection", () => {
    const input = selectionFixture();
    input.routines.push({ ...input.routines[0], id: "room-routine", target: "room-goal", groupId: "room" });
    expect(getBotPackageExportSelectionCandidates(input).routines.at(-1)).toMatchObject({ id: "room-routine", key: null, supported: false });
    expect(() => createBotPackageExport({ ...input, selection: { botIds: ["one"], playbookKeys: [], routineIds: ["room-routine"] } })).toThrow("Room-goal routines are not supported");
    expect(createBotPackageExport(input).package.routines).toHaveLength(2);
  });

  it("keeps collaboration structure while excluding runtime authority and state", () => {
    const exported = createBotPackageExport({
      name: "Launch Crew",
      authorName: "Mira",
      bots: [
        {
          id: "private-id",
          threadId: "private-thread",
          name: "Lead",
          title: "Chief",
          description: "Coordinates",
          notifications: true,
          color: "purple",
          unread: false,
          modelSelection: { instanceId: "private-engine", model: "secret-model", effort: "medium" },
          resumeCursors: { provider: "secret-session" },
          chiefOfStaff: true,
          composio: true,
          cwd: "/private/path",
          autoApprove: true,
          alwaysAllow: ["everything"],
          installedPackage: {
            id: "source",
            name: "Source",
            release: "1.0.0",
            requiredApps: [{ slug: "github", label: "GitHub", reason: "Read repositories.", optional: true }],
          },
          playbooks: [{ key: "launch", name: "Launch", summary: "Ship", triggers: ["launch plan"], instructions: "Verify the release." }],
          createdAt: 1,
        },
      ],
      groups: [{
        id: "private-room-id",
        threadId: "private-room-thread",
        name: "Launch Room",
        memberIds: ["private-id"],
        defaultResponder: { kind: "member", botId: "private-id" },
        bulletin: "Ship carefully.",
        unread: false,
        createdAt: 1,
      }],
      routines: [
        {
          id: "private-routine-id",
          name: "Release check",
          prompt: "Verify release readiness.",
          target: "bot",
          botId: "private-id",
          runOn: "ember",
          enabled: true,
          schedule: { type: "daily", time: "09:00", weekdays: [1] },
          durationMinutes: 30,
          attachments: [{
            id: "private-attachment",
            kind: "file",
            name: "private.txt",
            path: "/private/calendar/context.txt",
            size: 42,
          }],
          nextRunAt: 123,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "private-room-routine-id",
          name: "Team release review",
          prompt: "Review the release together.",
          target: "room-goal",
          groupId: "private-room-id",
          botId: "private-id",
          runOn: "ember",
          enabled: true,
          schedule: { type: "daily", time: "10:00", weekdays: [1] },
          durationMinutes: 30,
          nextRunAt: 456,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "private-interval-routine-id",
          name: "Frequent release check",
          prompt: "Watch release readiness.",
          target: "bot",
          botId: "private-id",
          runOn: "ember",
          enabled: true,
          schedule: { type: "interval", everyMinutes: 15, anchorAt: 1_788_254_400_000 },
          durationMinutes: 30,
          timeoutMinutes: 20,
          nextRunAt: 789,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    expect(exported.package.routines).toHaveLength(2);
    expect(exported.package.routines?.[1]?.schedule).toEqual({
      type: "interval",
      everyMinutes: 15,
      anchorAt: 1_788_254_400_000,
    });
    expect(exported.package.routines?.[1]?.timeoutMinutes).toBe(20);

    expect(exported).toMatchObject({
      format: "murage.package",
      package: {
        chiefOfStaff: "lead",
        requirements: { apps: [{ slug: "github" }] },
        rooms: [{ members: ["lead"], defaultResponder: { kind: "agent", agent: "lead" } }],
        routines: [
          { agent: "lead", enabledAfterInstall: false },
          { agent: "lead", enabledAfterInstall: false },
        ],
        playbooks: [{ key: "launch" }],
      },
    });
    expect(JSON.stringify(exported)).not.toMatch(/private-id|private-thread|private-engine|secret-model|secret-session|private\/path|private-attachment|autoApprove|alwaysAllow|nextRunAt/);
  });

  it("shares one identical playbook definition across multiple bots", () => {
    const sharedPlaybook = {
      key: "qualify",
      name: "Qualify",
      summary: "Check fit",
      triggers: ["qualify lead"],
      instructions: "Check the lead against the stated criteria.",
    };
    const bot = (id: string, name: string): BotRecord => ({
      id,
      threadId: `thread-${id}`,
      name,
      title: "Researcher",
      description: "Researches leads",
      notifications: true,
      color: "green" as const,
      unread: false,
      modelSelection: { instanceId: "engine", model: "model", effort: "medium" },
      resumeCursors: {},
      playbooks: [sharedPlaybook],
      createdAt: 1,
    });

    const exported = createBotPackageExport({
      name: "Lead Crew",
      bots: [bot("one", "Scout"), bot("two", "Reviewer")],
      groups: [],
      routines: [],
    });

    expect(exported.package.playbooks).toHaveLength(1);
    expect(exported.package.agents.map((agent) => agent.playbooks)).toEqual([
      ["qualify"],
      ["qualify"],
    ]);
  });
});

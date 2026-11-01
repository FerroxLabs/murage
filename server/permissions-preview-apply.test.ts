// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-L1B-1013 section 4, test 9 (gate tier). An owner's level change does
// exactly what the confirm card showed: the default PATCH refuses when anything
// the owner reviewed changed, the apply accepts only that PATCH's own bump, an
// Undo restores only what it changed, and a failed write leaves the old level.
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import * as atomic from "./atomic.ts";
import { commitLevelChange, levelChange, LEVEL_SAVE_FAILED } from "./level-change.ts";
import { Store } from "./store.ts";
import { permissionLevelPatch } from "./thread-permissions-refresh.ts";
import { api, desktopApi, home, STATE_ONLY_SELECTION } from "./testing/index-harness.ts";
import { raiseLevel } from "./testing/raise-level.ts";

afterEach(() => vi.restoreAllMocks());

const FULL = { fullAccess: true, acknowledgeFullAccess: true };
const LOWER_TO_ASK = { settingsScope: "defaults", autoApprove: false };
const LOWER_TO_AUTO = { settingsScope: "defaults", autoApprove: true, fullAccess: false };

async function makeBot(name = "Nova") {
  const created = await desktopApi("POST", "/api/bots", { name, modelSelection: STATE_ONLY_SELECTION });
  expect(created.status).toBe(201);
  const bot = created.body.bot as { id: string; threadId: string };
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  return bot;
}
/** A bot at Ask whose Full access warning was confirmed once, so a routine may carry a Full ceiling. */
async function warnedBot(name = "Nova") {
  const bot = await makeBot(name);
  expect((await raiseLevel(desktopApi, bot.id, FULL, { conversations: false })).status).toBe(200);
  expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, LOWER_TO_ASK)).status).toBe(200);
  return bot;
}
const routine = async (botId: string, permissionMode: string, name = `${permissionMode} routine`) => {
  const created = await desktopApi("POST", "/api/routines", { name, prompt: "p", botId, enabled: false, schedule: { type: "interval", everyMinutes: 30, anchorAt: Date.now() }, permissionMode });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.routine as { id: string };
};
const editRoutine = (id: string, patch: object) => desktopApi("PATCH", `/api/routines/${id}`, patch);
const refresh = (botId: string) => `/api/bots/${botId}/permissions/refresh`;
const preview = async (botId: string, targetLevel?: string) => {
  const answer = await desktopApi("POST", refresh(botId), { scope: "open", ...(targetLevel ? { targetLevel } : {}) });
  expect(answer.status).toBe(200);
  return answer.body;
};
const patchWith = (botId: string, seen: { previewId: string; botRev: number }, flags: object = FULL) =>
  desktopApi("PATCH", `/api/bots/${botId}`, { settingsScope: "defaults", previewId: seen.previewId, ifRev: seen.botRev, ...flags });
const apply = (botId: string, seen: { rosterId: string; targetLevel: string }, afterRev: number) =>
  desktopApi("POST", refresh(botId), { scope: "open", rosterId: seen.rosterId, targetLevel: seen.targetLevel, afterRev });
const onDisk = (botId: string) => (JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")) as any[]).find(bot => bot.id === botId);
const wire = async (botId: string) => (await desktopApi("GET", `/api/bots/${botId}?messages=0`)).body.bot;
const addConversation = async (botId: string) => (await desktopApi("POST", `/api/bots/${botId}/tasks`, { title: "Another" })).body.task as { threadId: string };
const taskPatch = (botId: string, threadId: string, body: object) => desktopApi("PATCH", `/api/bots/${botId}/tasks/${threadId}`, body);
const staleLevel = (level: string, permissionRev: number) => ({ code: "preview_stale", level, permissionRev });

describe("preview", () => {
  it("shows what each routine does at the level, and any ceiling edit changes routinesId", async () => {
    const bot = await warnedBot();
    const full = await routine(bot.id, "full", "Morning brief"), auto = await routine(bot.id, "auto", "Inbox"), ask = await routine(bot.id, "ask", "Quiet");
    const seen = await preview(bot.id, "full");
    expect(seen).toMatchObject({ targetLevel: "full", botLevel: "ask" });
    expect(seen.routines).toHaveLength(2);
    expect(seen.routines).toContainEqual({ id: full.id, name: "Morning brief", ceiling: "full", from: "ask", to: "full" });
    expect(seen.routines).toContainEqual({ id: auto.id, name: "Inbox", ceiling: "auto", from: "ask", to: "auto" });
    expect((await editRoutine(ask.id, { permissionMode: "auto" })).status).toBe(200);
    expect((await preview(bot.id, "full")).routinesId).not.toBe(seen.routinesId);
  }, 60_000);

  it("lists what a lowering takes down, and targetLevel left out keeps today's offer", async () => {
    const bot = await warnedBot();
    const full = await routine(bot.id, "full"), auto = await routine(bot.id, "auto");
    expect((await raiseLevel(desktopApi, bot.id, { fullAccess: true })).status).toBe(200);
    const seen = await preview(bot.id, "auto");
    expect(seen.routines).toEqual([{ id: full.id, name: "full routine", ceiling: "full", from: "full", to: "auto" }]);
    expect(seen.routines.map((item: { id: string }) => item.id)).not.toContain(auto.id);
    expect((await preview(bot.id)).targetLevel).toBe("full");
    expect((await desktopApi("POST", refresh(bot.id), { scope: "open", targetLevel: "max" })).status).toBe(400);
  }, 60_000);

  it("is the owner's computer's alone, and the earlier apply form is gone", async () => {
    const bot = await makeBot();
    expect((await api("POST", refresh(bot.id), { scope: "open" })).status).toBe(404);
    expect((await desktopApi("POST", refresh(bot.id), { scope: "open", previewId: "any" })).status).toBe(400);
    expect((await desktopApi("POST", refresh(bot.id), { scope: "open", rosterId: "any" })).status).toBe(400);
  });
});

describe("the default PATCH checks what the owner reviewed", () => {
  it("refuses when a routine's ceiling rose while the card was open", async () => {
    const bot = await warnedBot();
    const target = await routine(bot.id, "auto");
    const seen = await preview(bot.id, "full");
    expect((await editRoutine(target.id, { permissionMode: "full" })).status).toBe(200);
    const refused = await patchWith(bot.id, seen);
    expect(refused).toMatchObject({ status: 409, body: staleLevel("ask", seen.botRev) });
    expect(await wire(bot.id)).toMatchObject({ autoApprove: false, permissionRev: seen.botRev });
    expect((await desktopApi("GET", "/api/routines")).body.routines.find((item: { id: string }) => item.id === target.id).permissionMode).toBe("full");
    expect((await preview(bot.id, "full")).routines).toContainEqual(expect.objectContaining({ id: target.id, ceiling: "full", to: "full" }));
  }, 60_000);

  it("refuses when a routine was added, deleted or moved to another bot", async () => {
    const bot = await warnedBot(), other = await makeBot("Other");
    let seen = await preview(bot.id, "full");
    const added = await routine(bot.id, "auto");
    expect((await patchWith(bot.id, seen)).status).toBe(409);
    seen = await preview(bot.id, "full");
    expect((await desktopApi("PATCH", `/api/routines/${added.id}`, { botId: other.id })).status).toBe(200);
    expect((await patchWith(bot.id, seen)).status).toBe(409);
    const stays = await routine(bot.id, "auto");
    seen = await preview(bot.id, "full");
    expect((await desktopApi("DELETE", `/api/routines/${stays.id}`)).status).toBeLessThan(300);
    expect((await patchWith(bot.id, seen)).status).toBe(409);
    expect((await wire(bot.id)).autoApprove).toBe(false);
  }, 60_000);

  it("refuses when a conversation or the bot's level changed", async () => {
    const bot = await warnedBot();
    let seen = await preview(bot.id, "full");
    expect((await taskPatch(bot.id, bot.threadId, { autoApprove: true })).status).toBe(200);
    expect((await patchWith(bot.id, seen)).status).toBe(409);
    seen = await preview(bot.id, "full");
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", autoApprove: true })).status).toBe(200);
    expect(await patchWith(bot.id, seen)).toMatchObject({ status: 409, body: staleLevel("auto", seen.botRev + 1) });
  }, 60_000);
});

describe("the two paths", () => {
  it("applies with the PATCH's revision, and only that", async () => {
    const bot = await makeBot();
    const second = await addConversation(bot.id);
    const seen = await preview(bot.id, "full");
    expect(seen.eligible).toHaveLength(2);
    const raised = await patchWith(bot.id, seen);
    expect(raised.status).toBe(200);
    expect(raised.body.permissionRev).toBe(seen.botRev + 1);
    expect(onDisk(bot.id).permissionPrev).toMatchObject({ level: "ask", rev: seen.botRev, routinesId: seen.routinesId });
    expect((await wire(bot.id)).permissionPrev).toBeUndefined();
    expect((await apply(bot.id, seen, seen.botRev)).status).toBe(409);
    const applied = await apply(bot.id, seen, raised.body.permissionRev);
    expect(applied.status).toBe(200);
    expect(applied.body.changed).toHaveLength(2);
    expect(applied.body.changed).toContainEqual({ threadId: second.threadId, from: "ask", to: "full", rev: 1 });
    expect(onDisk(bot.id).tasks.map((task: any) => task.permissionRev)).toEqual([1, 1]);
  }, 60_000);

  it("writes nothing when a conversation changed between the PATCH and the apply", async () => {
    const bot = await makeBot();
    const second = await addConversation(bot.id);
    const seen = await preview(bot.id, "full");
    const raised = await patchWith(bot.id, seen);
    expect((await taskPatch(bot.id, second.threadId, { autoApprove: true })).status).toBe(200);
    const before = onDisk(bot.id).tasks;
    expect((await apply(bot.id, seen, raised.body.permissionRev)).status).toBe(409);
    expect(onDisk(bot.id).tasks).toEqual(before);
  }, 60_000);

  it("Only new conversations leaves every conversation where it was", async () => {
    const bot = await makeBot();
    await addConversation(bot.id);
    const before = onDisk(bot.id).tasks;
    expect((await patchWith(bot.id, await preview(bot.id, "full"))).status).toBe(200);
    expect(onDisk(bot.id).tasks).toEqual(before);
    expect((await wire(bot.id)).fullAccess).toBe(true);
  }, 60_000);

  it("answers the current level when the default moved again before the apply", async () => {
    const bot = await makeBot();
    const seen = await preview(bot.id, "full");
    const raised = await patchWith(bot.id, seen);
    const lowered = await desktopApi("PATCH", `/api/bots/${bot.id}`, LOWER_TO_AUTO);
    expect(await apply(bot.id, seen, raised.body.permissionRev)).toMatchObject({ status: 409, body: staleLevel("auto", lowered.body.permissionRev) });
  }, 60_000);
});

describe("raises and the step back", () => {
  it("needs the preview, or the exact step back", async () => {
    const bot = await warnedBot();
    expect((await raiseLevel(desktopApi, bot.id, { fullAccess: true })).status).toBe(200);
    expect(await desktopApi("PATCH", `/api/bots/${bot.id}`, { ...LOWER_TO_ASK })).toMatchObject({ status: 200 });
    const plain = await desktopApi("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", fullAccess: true });
    expect(plain).toMatchObject({ status: 400, body: { error: "Review the change first." } });
    const legacy = await desktopApi("PATCH", `/api/bots/${bot.id}`, { fullAccess: true });
    expect(legacy).toMatchObject({ status: 400, body: { error: "Review the change first." } });
    const seen = await preview(bot.id, "full");
    const lowered = await patchWith(bot.id, seen);
    const down = await desktopApi("PATCH", `/api/bots/${bot.id}`, { ...LOWER_TO_AUTO, ifRev: lowered.body.permissionRev });
    expect(down.status).toBe(200);
    const back = await desktopApi("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", ifRev: down.body.permissionRev, fullAccess: true });
    expect(back.status).toBe(200);
    expect(back.body.permissionRev).toBe(down.body.permissionRev + 1);
    expect((await wire(bot.id)).fullAccess).toBe(true);
  }, 60_000);

  it("refuses the step back after anything moved", async () => {
    const bot = await warnedBot();
    const raise = async () => (await patchWith(bot.id, await preview(bot.id, "full"))).body.permissionRev as number;
    const lower = async (ifRev: number) => (await desktopApi("PATCH", `/api/bots/${bot.id}`, { ...LOWER_TO_AUTO, ifRev })).body.permissionRev as number;
    const stepBack = (ifRev: number) => desktopApi("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", ifRev, fullAccess: true });
    // Auto to Ask to Auto elsewhere: the revision moved
    const dropped = await lower(await raise());
    await desktopApi("PATCH", `/api/bots/${bot.id}`, LOWER_TO_ASK);
    const elsewhere = await desktopApi("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", autoApprove: true });
    expect((await stepBack(dropped)).status).toBe(409);
    // the same revision, a level the bot did not just leave
    expect((await stepBack(elsewhere.body.permissionRev)).status).toBe(409);
    // the routines changed: edited, added, deleted, moved here
    const edited = await routine(bot.id, "auto");
    let rev = await lower(await raise());
    expect((await editRoutine(edited.id, { permissionMode: "full" })).status).toBe(200);
    expect((await stepBack(rev)).status).toBe(409);
    rev = await lower(await raise());
    const added = await routine(bot.id, "auto");
    expect((await stepBack(rev)).status).toBe(409);
    rev = await lower(await raise());
    expect((await desktopApi("DELETE", `/api/routines/${added.id}`)).status).toBeLessThan(300);
    expect((await stepBack(rev)).status).toBe(409);
    const other = await warnedBot("Other"), moved = await routine(other.id, "auto");
    rev = await lower(await raise());
    expect((await desktopApi("PATCH", `/api/routines/${moved.id}`, { botId: bot.id })).status).toBe(200);
    expect((await stepBack(rev)).status).toBe(409);
    expect((await wire(bot.id)).fullAccess).toBe(false);
  }, 120_000);

  it("takes one of two PATCHes with the same revision", async () => {
    const bot = await makeBot();
    const seen = await preview(bot.id, "full");
    const answers = await Promise.all([patchWith(bot.id, seen), patchWith(bot.id, seen)]);
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 409]);
    expect(onDisk(bot.id).permissionRev).toBe(seen.botRev + 1);
  }, 60_000);

  it("carries the warning's confirmation in the raise, and an old record reads 0", async () => {
    const bot = await makeBot();
    const seen = await preview(bot.id, "full");
    expect(seen.botRev).toBe(0);
    expect(onDisk(bot.id).permissionRev).toBeUndefined();
    expect((await patchWith(bot.id, seen, { fullAccess: true })).status).toBe(400);
    expect((await wire(bot.id)).fullAccessAcknowledgedAt).toBeUndefined();
    const raised = await patchWith(bot.id, seen);
    expect(raised.status).toBe(200);
    expect(raised.body.permissionRev).toBe(1);
    expect((await wire(bot.id)).fullAccessAcknowledgedAt).toEqual(expect.any(Number));
  }, 60_000);

  it("says which routines a lowering moved", async () => {
    const bot = await warnedBot();
    const full = await routine(bot.id, "full");
    expect((await raiseLevel(desktopApi, bot.id, { fullAccess: true })).status).toBe(200);
    const down = await desktopApi("PATCH", `/api/bots/${bot.id}`, LOWER_TO_AUTO);
    expect(down.body.routines).toEqual([{ id: full.id, name: "full routine", ceiling: "full", from: "full", to: "auto" }]);
  }, 60_000);

  it("a same-level PATCH is not a level write", async () => {
    const bot = await makeBot();
    const raised = await patchWith(bot.id, await preview(bot.id, "full"));
    const same = await desktopApi("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", fullAccess: true });
    expect(same.status).toBe(200);
    expect(same.body.permissionRev).toBe(raised.body.permissionRev);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { name: "Renamed" })).body.permissionRev).toBe(raised.body.permissionRev);
  }, 60_000);
});

describe("Undo", () => {
  it("restores each conversation on its own, and the bot's Undo touches none", async () => {
    const bot = await makeBot();
    await addConversation(bot.id);
    const third = await addConversation(bot.id);
    const seen = await preview(bot.id, "full");
    const raised = await patchWith(bot.id, seen);
    const { changed } = (await apply(bot.id, seen, raised.body.permissionRev)).body;
    expect(changed).toHaveLength(3);
    expect((await taskPatch(bot.id, third.threadId, { autoApprove: true, fullAccess: false })).status).toBe(200);
    const before = onDisk(bot.id).tasks;
    const undone = await desktopApi("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", autoApprove: false, ifRev: raised.body.permissionRev });
    expect(undone.status).toBe(200);
    expect(onDisk(bot.id).tasks).toEqual(before);
    const answers = await Promise.all(changed.map((row: { threadId: string; rev: number }) =>
      taskPatch(bot.id, row.threadId, { autoApprove: false, ifRev: row.rev })));
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 200, 409]);
    expect(answers.find(answer => answer.status === 409)).toMatchObject({ body: staleLevel("auto", 2) });
    const restored = answers.find(answer => answer.status === 200)!;
    expect(restored.body).toMatchObject({ permissionRev: 2 });
    expect(restored.body.task.permissionRev).toBe(2);
  }, 60_000);

  it("a conversation's ifRev is a revision, and a title moves no revision", async () => {
    const bot = await makeBot();
    expect((await taskPatch(bot.id, bot.threadId, { autoApprove: true, ifRev: "1" })).status).toBe(400);
    expect((await taskPatch(bot.id, bot.threadId, { title: "Named" })).body.permissionRev).toBe(0);
    expect((await taskPatch(bot.id, bot.threadId, { autoApprove: true, ifRev: 0 })).body.permissionRev).toBe(1);
  });
});

describe("a bot with one conversation", () => {
  it("keeps the conversation out of the default, both paths and the Undo", async () => {
    const bot = await makeBot();
    const before = onDisk(bot.id).tasks;
    const seen = await preview(bot.id, "full");
    const raised = await patchWith(bot.id, seen);
    expect(onDisk(bot.id).tasks).toEqual(before);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", autoApprove: false, ifRev: raised.body.permissionRev })).status).toBe(200);
    expect(onDisk(bot.id).tasks).toEqual(before);
  }, 60_000);

  it("ifRev needs settingsScope defaults, the desktop's alone", async () => {
    const bot = await makeBot();
    expect(await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: false, ifRev: 0 })).toMatchObject({ status: 400 });
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: false, ifRev: "0", settingsScope: "defaults" })).status).toBe(400);
    expect((await api("PATCH", `/api/bots/${bot.id}`, { autoApprove: false, ifRev: 0, settingsScope: "defaults" })).status).toBe(404);
  });

  it("leaves a conversation the preview skipped at its level", async () => {
    const bot = await makeBot();
    expect((await taskPatch(bot.id, bot.threadId, { autoApprove: true, fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
    const seen = await preview(bot.id, "auto");
    expect(seen.skipped).toContainEqual({ threadId: bot.threadId, reason: "already-at-level" });
    const before = onDisk(bot.id).tasks;
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { settingsScope: "defaults", autoApprove: true, ifRev: seen.botRev })).status).toBe(200);
    expect(onDisk(bot.id).tasks).toEqual(before);
  }, 60_000);

  it("a default repeated at its level does not lift a sole conversation past the review", async () => {
    const bot = await makeBot();
    await patchWith(bot.id, await preview(bot.id, "full"));
    const before = onDisk(bot.id);
    expect(before.tasks).toHaveLength(1);
    expect(before.tasks[0].fullAccess).toBeFalsy();
    const repeated = await desktopApi("PATCH", `/api/bots/${bot.id}`, FULL);
    expect(repeated.status).toBe(200);
    expect(onDisk(bot.id).tasks).toEqual(before.tasks);
    expect(onDisk(bot.id).permissionRev).toBe(before.permissionRev);
  }, 60_000);

  it("a legacy lowering keeps its one-conversation mirror, in the same write, with the conversation's revision", async () => {
    const bot = await makeBot();
    const seen = await preview(bot.id, "full");
    const raised = await patchWith(bot.id, seen);
    await apply(bot.id, seen, raised.body.permissionRev);
    const lowered = await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: false });
    expect(lowered.status).toBe(200);
    expect(onDisk(bot.id).tasks[0]).toMatchObject({ autoApprove: false, permissionRev: 2, permissionPrev: { level: "full", rev: 1 } });
  }, 60_000);
});

describe("a failed write", () => {
  it("answers 500 and leaves the old level, and the next PATCH with the same revision succeeds", async () => {
    if (process.platform === "win32") return;
    const bot = await makeBot();
    const seen = await preview(bot.id, "full");
    const dir = join(home, ".murage");
    chmodSync(dir, 0o555);
    let refused;
    try { refused = await patchWith(bot.id, seen); } finally { chmodSync(dir, 0o755); }
    expect(refused).toMatchObject({ status: 500, body: { error: LEVEL_SAVE_FAILED } });
    const after = await wire(bot.id);
    expect(after.autoApprove === true || after.permissionRev !== undefined).toBe(false);
    expect(onDisk(bot.id).permissionRev).toBeUndefined();
    expect((await patchWith(bot.id, seen)).status).toBe(200);
  }, 60_000);

  it("changes nothing live and emits nothing", () => {
    const store = new Store(() => STATE_ONLY_SELECTION), bot = store.createBot();
    const changes: unknown[] = [], unsubscribe = store.onChange(change => changes.push(change));
    const before = JSON.stringify(bot), revision = store.revision, original = atomic.writeFileAtomic;
    const disk = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((...args) => {
      if (String(args[0]) === join(DATA_DIR, "bots.json")) throw new Error("fixture write failure");
      return original(...args);
    });
    const change = levelChange({ bot, patch: { ...permissionLevelPatch("auto") }, routines: () => [], candidates: () => [] });
    expect(change.action).toBe("write");
    if (change.action !== "write") return;
    expect(commitLevelChange(store, bot.id, change, { preserveTaskSettings: true })).toBe("failed");
    expect(JSON.stringify(bot)).toBe(before);
    expect(store.revision).toBe(revision);
    expect(changes).toEqual([]);
    disk.mockRestore();
    expect(commitLevelChange(store, bot.id, change, { preserveTaskSettings: true })).toMatchObject({ autoApprove: true, permissionRev: 1 });
    expect(changes).toHaveLength(1);
    unsubscribe();
  });
});

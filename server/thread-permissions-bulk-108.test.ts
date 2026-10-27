// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openRefreshPreview, permissionLevelPatch, PERMISSION_LEVELS, openPermissionExclusion } from "./thread-permissions-refresh.ts";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import * as atomic from "./atomic.ts";
import { Store } from "./store.ts";
import { api, desktopApi, STATE_ONLY_SELECTION } from "./testing/index-harness.ts";

afterEach(() => vi.restoreAllMocks());

const candidate = (level: typeof PERMISSION_LEVELS[number], threadId = "owner", extra = {}) => ({ threadId, binding: "owner:1", ...permissionLevelPatch(level), ...extra });
describe("108 raise-only preview", () => {
  it("offers existing Full defaults and handles every level pair without lowering or copying grants", () => {
    for (const [targetRank, target] of PERMISSION_LEVELS.entries()) for (const [fromRank, from] of PERMISSION_LEVELS.entries()) {
      const preview = openRefreshPreview({ ...permissionLevelPatch(target), alwaysAllow: ["fixture-grant"] }, [candidate(from)]);
      expect(preview.eligible.length).toBe(fromRank < targetRank ? 1 : 0);
      expect(permissionLevelPatch(target)).not.toHaveProperty("alwaysAllow");
    }
    expect(openRefreshPreview(permissionLevelPatch("full"), [candidate("ask")]).eligible).toHaveLength(1);
  });
  it("excludes mixed owners, rooms without owner membership, busy cards and closed or automation work", () => {
    const eligible = { owner: true, automation: false, closed: false, roomOwner: true, busy: false };
    expect(openPermissionExclusion(eligible)).toBeUndefined();
    for (const [patch, reason] of [[{ owner: false }, "other-owner"], [{ automation: true }, "automation"], [{ closed: true }, "closed"], [{ roomOwner: false }, "room-owner"], [{ busy: true }, "busy"]] as const) expect(openPermissionExclusion({ ...eligible, ...patch })).toBe(reason);
  });
  it("hashes all ownership, room, busy, archived and candidate changes", () => {
    const base = [candidate("ask"), candidate("auto", "second")], bot = permissionLevelPatch("full");
    const id = openRefreshPreview(bot, base).previewId;
    for (const reason of ["other-owner", "room-owner", "busy", "closed", "automation"]) {
      const changed = openRefreshPreview(bot, [{ ...base[0]!, reason }, base[1]!]);
      expect(changed.previewId).not.toBe(id); expect(changed.eligible.map(row => row.threadId)).toEqual(["second"]);
      expect(changed.skipped).toContainEqual({ threadId: "owner", reason });
    }
    for (const roster of [[base[0]!], [...base, candidate("ask", "third")], [{ ...base[0]!, binding: "other:2" }, base[1]!], [candidate("auto"), base[1]!]]) expect(openRefreshPreview(bot, roster).previewId).not.toBe(id);
    expect(openRefreshPreview(permissionLevelPatch("no-limits"), base).previewId).not.toBe(id);
    expect(openRefreshPreview(bot, [...base].reverse()).previewId).toBe(id);
  });
  it("persists once, keeps defaults and grants, publishes nothing on failure, and reopens the roster", () => {
    const store = new Store(() => STATE_ONLY_SELECTION), bot = store.createBot();
    const second = store.createTask(bot.id, "second", false)!;
    store.patchBot(bot.id, { ...permissionLevelPatch("full"), alwaysAllow: ["bot-only"] }, { preserveTaskSettings: true });
    store.patchTask(bot.id, bot.threadId, { ...permissionLevelPatch("ask"), alwaysAllow: ["task-only"] });
    store.patchTask(bot.id, second.threadId, permissionLevelPatch("ask"));
    const changes: unknown[] = []; const unsubscribe = store.onChange(change => changes.push(change));
    const revision = store.revision;
    const before = JSON.stringify(bot), save = vi.spyOn(store as any, "saveBots");
    const diskBefore = readFileSync(join(DATA_DIR, "bots.json"), "utf8");
    const originalWrite = atomic.writeFileAtomic;
    const disk = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((...args) => {
      if (String(args[0]) === join(DATA_DIR, "bots.json")) throw new Error("fixture write failure");
      return originalWrite(...args);
    });
    expect(() => store.raiseTaskPermissions(bot.id, [bot.threadId, second.threadId], permissionLevelPatch("full"))).toThrow("fixture write failure");
    expect(JSON.stringify(bot)).toBe(before); expect(store.revision).toBe(revision); expect(changes).toEqual([]); expect(save).toHaveBeenCalledTimes(1);
    disk.mockRestore(); expect(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).toBe(diskBefore);
    save.mockRestore(); const successful = vi.spyOn(store as any, "saveBots");
    expect(store.raiseTaskPermissions(bot.id, [bot.threadId, second.threadId], permissionLevelPatch("full"))).toBe(2);
    expect(successful).toHaveBeenCalledTimes(1); successful.mockRestore(); unsubscribe();
    expect(store.taskByThread(bot.id, bot.threadId)?.alwaysAllow).toEqual(["task-only"]);
    const reopened = new Store(() => STATE_ONLY_SELECTION);
    expect(reopened.bot(bot.id)?.fullAccess).toBe(true);
    for (const threadId of [bot.threadId, second.threadId]) expect(reopened.taskByThread(bot.id, threadId)?.fullAccess).toBe(true);
    expect(reopened.bot(bot.id)?.alwaysAllow).toEqual(["bot-only"]);
  });
});
describe("108 isolated desktop API", () => {
  it("requires owner desktop authentication, previews an existing Full default and refuses stale applies", async () => {
    const created = await desktopApi("POST", "/api/bots", { name: "Bulk fixture", modelSelection: STATE_ONLY_SELECTION });
    expect(created.status).toBe(201); const bot = created.body.bot;
    const path = `/api/bots/${bot.id}/permissions/refresh`;
    expect((await api("POST", path, { scope: "open" })).status).toBe(404);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { autoApprove: true, fullAccess: true, acknowledgeFullAccess: true })).status).toBe(200);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { autoApprove: false, fullAccess: false, noLimits: false })).status).toBe(200);
    let preview = await desktopApi("POST", path, { scope: "open" });
    expect(preview.status).toBe(200); expect(preview.body.eligible).toContainEqual({ threadId: bot.threadId, from: "ask", to: "full" });
    expect((await desktopApi("POST", path, { scope: "open", previewId: "stale" })).status).toBe(409);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { autoApprove: true, fullAccess: false })).status).toBe(200);
    expect((await desktopApi("POST", path, { scope: "open", previewId: preview.body.previewId })).status).toBe(409);
    preview = await desktopApi("POST", path, { scope: "open" });
    expect(preview.body.eligible).toContainEqual({ threadId: bot.threadId, from: "auto", to: "full" });
    const applied = await desktopApi("POST", path, { scope: "open", previewId: preview.body.previewId });
    expect(applied.status).toBe(200); expect(applied.body.changed).toBeGreaterThan(0);
    expect((await desktopApi("POST", path, { scope: "open", previewId: preview.body.previewId })).status).toBe(409);
  });
  it("offers the explicit action independently of default changes and confirms count, level and skipped rooms", () => {
    const source = readFileSync(new URL("../src/components/BotPermissionDefault.tsx", import.meta.url), "utf8");
    expect(source).toContain('desktop === true && botId && <OpenConversationPermissions');
    expect(source).toContain('!!preview?.eligible.length && !confirm');
    expect(source).toContain("Apply to my open conversations");
    expect(source).toContain('role="dialog" aria-label="Apply approval level"');
    expect(source).toContain("Raise {preview.eligible.length} conversations to {label}");
    expect(source).toContain("Follows the bot default");
    expect(source).toContain("previewId: preview.previewId");
    expect(source).toContain("if (!acknowledged) { onConfirmLevel(); return; }");
    expect(source).toContain("onConfirmLevel={() => onChoose(current)}");
  });
});

// ELD250 rebase onto b13z17: setResumeCursor is split into applyResumeCursor (the record change) plus its save and announcement, and
// clearResumeCursors batches the repair's clears. The tip's setResumeCursor also keeps a Fuigo cursor's policy and replay-pending maps
// on the task and mirrors both, cloned, onto the bot. The split must carry both fields exactly as the tip does.
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { FUIGO_POLICY_SHA256 } from "./drivers/acp/fuigo-policy.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const policy = { root: DATA_DIR, sha256: FUIGO_POLICY_SHA256 };
const fixture = () => {
  const store = new Store(() => ({ instanceId: "fuigo", model: "fixture", effort: "medium" }));
  const bot = store.createBot();
  const task = () => store.taskByThread(bot.id, bot.threadId)!;
  const save = (cursor: string | undefined, fuigo?: { policy: typeof policy; replayPending?: boolean }) => store.setResumeCursor(bot.id, "fuigo", cursor, bot.threadId, undefined, undefined, false, undefined, undefined, fuigo);
  return { store, bot, task, save };
};

describe("the resume-cursor split keeps resumePolicies and replayPending (ELD250 on b13z17)", () => {
  it("setResumeCursor through the split stores both maps on the task and mirrors a clone of each onto the bot", () => {
    const { bot, task, save } = fixture();
    save("S1", { policy, replayPending: true });
    expect(task().resumePolicies).toEqual({ fuigo: policy });
    expect(task().replayPending).toEqual({ fuigo: { cursor: "S1" } });
    expect(bot.resumePolicies).toEqual({ fuigo: policy });
    expect(bot.replayPending).toEqual({ fuigo: { cursor: "S1" } });
    // a clone, not the task's own object
    expect(bot.resumePolicies).not.toBe(task().resumePolicies);
    expect(bot.replayPending).not.toBe(task().replayPending);
    // deep separation, both ways: a nested field changed on one side leaves the other unchanged
    const botPolicy = bot.resumePolicies!.fuigo as { root: string }, taskPolicy = task().resumePolicies!.fuigo as { root: string };
    const botPending = bot.replayPending!.fuigo as { cursor: string }, taskPending = task().replayPending!.fuigo as { cursor: string };
    expect(botPolicy).not.toBe(taskPolicy);
    expect(botPending).not.toBe(taskPending);
    botPolicy.root = "changed-on-bot"; botPending.cursor = "changed-on-bot";
    expect(taskPolicy.root).toBe(DATA_DIR);
    expect(taskPending.cursor).toBe("S1");
    taskPolicy.root = "changed-on-task"; taskPending.cursor = "changed-on-task";
    expect(botPolicy.root).toBe("changed-on-bot");
    expect(botPending.cursor).toBe("changed-on-bot");
    taskPolicy.root = DATA_DIR; taskPending.cursor = "S1"; botPolicy.root = DATA_DIR; botPending.cursor = "S1";
    // a later save of another cursor without the Fuigo grant drops both, on the task and on the mirror
    save("S2");
    expect(task().resumePolicies?.fuigo).toBeUndefined();
    expect(task().replayPending?.fuigo).toBeUndefined();
    expect(bot.resumePolicies?.fuigo).toBeUndefined();
    expect(bot.replayPending?.fuigo).toBeUndefined();
  });

  it("clearResumeCursors clears both maps on the task and on the bot's mirror, announcing the bot once", () => {
    const { store, bot, task, save } = fixture();
    save("S1", { policy, replayPending: true });
    const changes: string[] = [];
    store.onChange((change) => { if (change.type === "bot") changes.push(change.botId); });
    expect(store.clearResumeCursors([{ botId: bot.id, instanceId: "fuigo", threadId: bot.threadId, cursor: "S1", incarnation: undefined }])).toEqual({ cleared: 1, botsMoved: 1, skipped: 0 });
    expect(task().resumeCursors.fuigo).toBeUndefined();
    expect(task().resumePolicies?.fuigo).toBeUndefined();
    expect(task().replayPending?.fuigo).toBeUndefined();
    expect(bot.resumeCursors.fuigo).toBeUndefined();
    expect(bot.resumePolicies?.fuigo).toBeUndefined();
    expect(bot.replayPending?.fuigo).toBeUndefined();
    expect(changes).toEqual([bot.id]);
  });
});

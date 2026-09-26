// 0.1.60 Linux re-test 2 D6: one approval left waiting blocked the first
// backup and every daily one, with only "Murage was busy" to show for it.
import { describe, expect, it } from "vitest";

import { backupWaitingSentence, backupWaitingBots } from "../shared/backup-waiting.ts";
import { backupWaitingBotsFrom, createBackupWaitTracker } from "./backup-waiting.ts";

const bots: Record<string, { id: string; name: string }> = { ember: { id: "ember", name: "Ember" }, log: { id: "log", name: "Log writer" } };
const messages: Record<string, Array<{ id: string; from?: { botId?: string }; card?: { answered?: unknown; dismissed?: boolean; expired?: boolean } }>> = {
  t1: [{ id: "m1", card: {} }, { id: "m2", card: { answered: "allow" } }],
  t2: [{ id: "m3", card: { dismissed: true } }],
  room: [{ id: "m4", from: { botId: "log" }, card: {} }],
  t3: [{ id: "m5" }],
};
const deps = {
  messagesFor: (threadId: string) => messages[threadId] ?? [],
  botFor: (threadId: string, asking?: string) => asking ? bots[asking] : threadId === "room" ? undefined : bots.ember,
};

describe("who a held-up backup is waiting for", () => {
  it("names each open, unanswered card's bot once; answered, dismissed and non-card messages are not waiting", () => {
    expect(backupWaitingBotsFrom([["t1:r1", "m1"], ["t1:r1b", "m1"], ["t1:r2", "m2"], ["t2:r3", "m3"], ["room:r4", "m4"], ["t3:r5", "m5"], ["gone:r6", "mx"], ["bad", "m1"]], deps))
      .toEqual([{ botId: "ember", name: "Ember", threadId: "t1", messageId: "m1" }, { botId: "log", name: "Log writer", threadId: "room", messageId: "m4" }]);
  });
  it("says who, in one sentence, for a daily backup, a Back up now and a skipped day", () => {
    const one = [{ botId: "ember", name: "Ember", threadId: "t1" }];
    expect(backupWaitingSentence(one, "daily")).toBe("Today's backup is waiting because Ember is waiting for your answer. Answer it, or end that run, and the backup starts by itself.");
    expect(backupWaitingSentence(one, "manual")).toBe("The backup can't start because Ember is waiting for your answer. Answer it, or end that run, then back up again.");
    expect(backupWaitingSentence(one, "skipped")).toBe("The last daily backup was skipped because Ember was waiting for your answer. Answer it, or end that run, so the next backup can run.");
    const two = [...one, { botId: "ember", name: "Ember", threadId: "t9" }, { botId: "log", name: "Log writer", threadId: "room" }];
    expect(backupWaitingSentence(two, "daily")).toBe("Today's backup is waiting because Ember and Log writer are waiting for your answer. Answer them, or end those runs, and the backup starts by itself.");
    const many = ["A", "B", "C"].map(name => ({ botId: name, name, threadId: name }));
    expect(backupWaitingSentence(many, "daily")).toContain("because 3 bots are waiting");
    for (const sentence of [backupWaitingSentence(one, "daily"), backupWaitingSentence(many, "skipped")]) expect(sentence).not.toMatch(/[—]|busy/);
  });
  it("keeps only well-formed entries when the list crosses a process", () => {
    expect(backupWaitingBots([{ botId: "b", name: "Ember", threadId: "t" }, { botId: "b", name: "x\ny", threadId: "t" }, { name: "no id" }, null, "x"]))
      .toEqual([{ botId: "b", name: "Ember", threadId: "t" }]);
  });
});

describe("the backup wait tracker", () => {
  const setup = () => {
    let now = 1_000_000;
    const told: Array<{ botId: string; text: string }> = [];
    const tracker = createBackupWaitTracker({ now: () => now, notify: (bot, text) => told.push({ botId: bot.botId, text }) });
    return { tracker, told, advance: (ms: number) => { now += ms; }, now: () => now };
  };
  const ember = { botId: "ember", name: "Ember", threadId: "t1", messageId: "m1" };
  it("rings once per bot for a daily backup that keeps being refused, and the Inbox shows it while it lasts", () => {
    const { tracker, told, advance, now } = setup();
    const since = now();
    for (let minute = 0; minute < 30; minute++) { tracker.refused([ember], "daily"); advance(60_000); }
    expect(told).toEqual([{ botId: "ember", text: "Today's backup is waiting because Ember is waiting for your answer. Answer it, or end that run, and the backup starts by itself." }]);
    expect(tracker.current([ember])).toEqual({ since, bots: [ember] });
    // answered: nobody waiting now, so nothing to show before the next try
    expect(tracker.current([])).toBeNull();
    // a second bot joining the same episode rings for that bot only
    tracker.refused([ember, { ...ember, botId: "log", name: "Log writer", threadId: "t2" }], "daily");
    expect(told.map(entry => entry.botId)).toEqual(["ember", "log"]);
  });
  it("ends the episode when a backup starts, or when the desktop stops asking", () => {
    const { tracker, told, advance } = setup();
    tracker.refused([ember], "daily"); tracker.proceeded();
    expect(tracker.current([ember])).toBeNull();
    tracker.refused([ember], "daily"); expect(told).toHaveLength(2);
    advance(4 * 60_000);
    expect(tracker.current([ember])).toBeNull();
    tracker.refused([ember], "daily"); expect(told).toHaveLength(3);
  });
  it("never rings or lists for Back up now, which the person is looking at", () => {
    const { tracker, told } = setup();
    tracker.refused([ember], "manual");
    expect(told).toEqual([]);
    expect(tracker.current([ember])).toBeNull();
  });
});

describe("the notification", () => {
  it("is titled for the backup, opens the waiting conversation, and follows the attention preference", async () => {
    const { buildNotification } = await import("./notify.ts");
    const { applyNotificationPreferences } = await import("../shared/notification-preferences.ts");
    const frame = buildNotification("backup-waiting", { id: "ember", name: "Ember", threadId: "main" }, "t1", backupWaitingSentence([{ botId: "ember", name: "Ember", threadId: "t1" }], "daily"), { messageId: "m1" });
    expect(frame).toMatchObject({ kind: "backup-waiting", title: "Today's backup is waiting", threadId: "t1", messageId: "m1", body: expect.stringContaining("Ember is waiting for your answer") });
    expect(applyNotificationPreferences(frame!, { attention: false }, new Date())).toBeNull();
    expect(applyNotificationPreferences(frame!, { previewContent: false }, new Date())?.body).toBe("Your attention is needed.");
  });
});

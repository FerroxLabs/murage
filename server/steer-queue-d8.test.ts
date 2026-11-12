import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendStore } from "./send-store.ts";
import { drainSteeredMessages, _resetQueuedStarts } from "./steer-queue.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { DATA_DIR } from "./config.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const fx = JSON.parse(readFileSync(new URL("../apps/mobile/contract/phone-ask-proof.json", import.meta.url), "utf8"));
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); _resetQueuedStarts(); });
afterEach(() => { _resetQueuedStarts(); closeDatabase(); });

describe("T-D8-ROW batch", () => {
  it.each(["ask-intent", "share", "plain"] as const)("carries proof only for a single ask-intent, source %s", via => {
    const store = new Store(() => ({ instanceId: "fake", model: "fake" }));
    const bot = store.createBot();
    const first = sendStore.accept({
      kind: "bot", ownerId: bot.id, threadId: bot.threadId, fingerprint: "one", text: "hello", status: "queued",
      ...(via === "plain" ? { origin: "desktop" } : { via, queueOnly: true as const, origin: "unproven", viaDevice: fx.record.deviceId }),
      viaProof: fx.record,
    }).row;
    // A stored proof on a different source must not leak into the batch, even if the database contains it.
    database().prepare("UPDATE owner_sends SET via_proof=? WHERE seq=?").run(JSON.stringify(fx.record), first.seq);
    sendStore.accept({ kind: "bot", ownerId: bot.id, threadId: bot.threadId, fingerprint: "two", text: "later", status: "queued", origin: "desktop" });
    const run = vi.fn();
    drainSteeredMessages(store, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][5]).toEqual({ via: via === "plain" ? null : via, viaDevice: via === "plain" ? null : fx.record.deviceId, viaProof: via === "ask-intent" ? fx.record : null });
    expect(run.mock.calls[0][4]).toHaveLength(via === "plain" ? 2 : 1);
    if (via !== "plain") expect(sendStore.queuedRows(bot.threadId)).toHaveLength(1);
  });
});

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { captureSource } from "./capture.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { forgetMemory } from "./forget.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { EarlyBundle, dispatchAccess } from "../early-bundle.ts";
import { assertMemoryAccess } from "./policy.ts";
import { databaseStamp } from "./replay-lineage.ts";

const botThread = "0b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b", otherThread = "1c2d3e4f-5061-4728-9bac-1d2e3f4a5b6c";
const roster = { bots: [{ id: "bot", threadId: botThread }, { id: "other", threadId: otherThread }], groups: [] };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); setMemoryMode("active"); });

function mint() {
  const registry = new InternalCapabilities(), generation = registry.begin("bot", botThread);
  const token = registry.mint({ botId: "bot", threadId: botThread, generation, depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
function capture(text: string) {
  const messageId = randomUUID(), id = `message:${botThread}:${messageId}`;
  captureSource(database(), { id, threadId: botThread, messageId, kind: "text", speaker: "owner", outcome: "recorded", text });
  return id;
}

// A resumed turn builds its memory bundle while the mounts run. A forget during
// the mounts used to leave the early access stale: the dispatch check threw
// MEMORY_CONTEXT_REVOKED, the whole setup (mounts included) ran again, and a
// redispatched turn showed an error card. The turn now rebuilds in place.
it("a forget during the mounts cancels the early bundle and mints a fresh access, with no throw", () => {
  const id = capture("the gate is green");
  const early = new EarlyBundle<string, ReturnType<typeof mint>>(mint());
  early.start(async () => "stale");
  const checked = databaseStamp();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id, revision: 1 }); // during the mounts
  expect(() => assertMemoryAccess(early.access)).toThrow("MEMORY_CONTEXT_REVOKED");
  let minted = 0;
  const chosen = dispatchAccess(early, checked, { assertCurrent: assertMemoryAccess, stamp: databaseStamp, mint: () => { minted++; return mint(); } });
  expect(minted).toBe(1);
  expect(chosen.access).not.toBe(early.access);
  expect(() => assertMemoryAccess(chosen.access)).not.toThrow();
  expect(chosen.earlyVerdictHolds).toBe(false);
  expect(early.take()).toBeUndefined(); // cancelled: the turn builds its own bundle, once
});

it("keeps the early access and its verdict when nothing moved, so the check runs once", () => {
  const early = new EarlyBundle<string, ReturnType<typeof mint>>(mint());
  early.start(async () => "fresh");
  const chosen = dispatchAccess(early, databaseStamp(), { assertCurrent: assertMemoryAccess, stamp: databaseStamp, mint: () => { throw new Error("must not mint"); } });
  expect(chosen.access).toBe(early.access);
  expect(chosen.earlyVerdictHolds).toBe(true);
});

it("does not trust the early verdict once the store has been written", () => {
  const early = new EarlyBundle<string, ReturnType<typeof mint>>(mint());
  const checked = databaseStamp();
  capture("an unrelated write during the mounts");
  const chosen = dispatchAccess(early, checked, { assertCurrent: assertMemoryAccess, stamp: databaseStamp, mint });
  expect(chosen.access).toBe(early.access);
  expect(chosen.earlyVerdictHolds).toBe(false);
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 rig (Maya's profile, Flux Auto): every hand-off to @Canvas ended "delegation to @Canvas could not start: it did not say why" and
// "This didn't start for @Canvas". The start had a reason of its own ("This bot cannot be reached from here.", code not_reachable), but the
// could-not-start chip sorted the words through the provider failure codes, found none, and printed "it did not say why". A start is Murage's
// own step, so every could-not-start line now names its reason: Murage's refusal by its code, a provider failure by its kind, anything else
// as a setup failure that points to the teammate's conversation, where the start's own words are kept for the owner.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { _resetPending, onDelegationReceipt, onOwedHandoffReply, queueDelegation } from "./delegations.ts";
import { startFailureCodeFrom, START_FAILURE_CODES } from "./failure-code.ts";
import { dispatchHandoff } from "./handoff-dispatch.ts";
import { outboundWords, status, statusFromStored } from "./murage-status.ts";
import { _resetOwnerMigration } from "./pending-delegations-schema.ts";
import { ownerWorld } from "./testing/handoff-worlds.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import type { BotName } from "./murage-status.ts";

const quietly = async <T>(run: () => T | Promise<T>): Promise<T> => { const error = console.error; console.error = () => {}; try { return await run(); } finally { console.error = error; } };
const fresh = () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); _resetOwnerMigration(); };
const canvas = "Canvas" as BotName;

describe("a hand-off that cannot start names its reason", () => {
  beforeEach(fresh);
  afterEach(() => { onDelegationReceipt(undefined); onOwedHandoffReply(undefined); _resetOwnerMigration(); _resetPending(); closeDatabase(); });

  for (const origin of ["owner", "room"] as const) {
    it(`${origin} origin: Murage's own refusal at the start (the rig's "cannot be reached") reaches the chip as its code (its own words stay in the teammate's conversation for the owner)`, async () => {
      const w = ownerWorld(origin);
      w.knobs.failStart = "This bot cannot be reached from here.";
      w.knobs.failStartCode = "not_reachable";
      const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "make three pictures", depth: 0 }, 2).id!;
      await quietly(() => dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus }));
      expect(w.turns).toEqual([]);
      expect(w.couldNotStart[0]).toMatchObject({ id, toBotId: w.target.id, code: "not_reachable", why: "This bot cannot be reached from here." });
      const chip = outboundWords(status("row_could_not_start", { name: canvas, why: w.couldNotStart[0]!.code }));
      expect(chip).toBe("error: delegation to @Canvas could not start: it cannot be reached from this conversation");
      expect(chip).not.toMatch(/did not say why/);
    });
  }

  it("a start that failed for a reason with no code is a setup failure, never \"it did not say why\"", async () => {
    const w = ownerWorld();
    w.knobs.failStart = "no such instance: missing-instance";
    const id = queueDelegation(w.bus, w.from, { toBotId: w.target.id, message: "pick this up", depth: 0 }, 2).id!;
    await quietly(() => dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus }));
    expect(w.couldNotStart[0]).toMatchObject({ id, code: "setup" });
    expect(w.couldNotStart[0]!.why).toContain("no such instance");
    for (const key of ["row_could_not_start", "peer_could_not_start"] as const) {
      expect(outboundWords(status(key, { name: canvas, why: "setup" }))).toMatch(/Murage could not set up its turn\. Its conversation has the details$/);
    }
  });

  it("a provider's failure keeps its kind", () => {
    expect(startFailureCodeFrom(new Error("429 Too Many Requests"))).toBe("rate_limit");
    expect(startFailureCodeFrom(new Error("Please sign in to continue"))).toBe("auth");
    expect(startFailureCodeFrom(Object.assign(new Error("Sharing is paused."), { code: "shared_paused" }))).toBe("shared_paused");
    expect(startFailureCodeFrom("something nobody named")).toBe("setup");
    expect(startFailureCodeFrom(undefined)).toBe("setup");
  });

  it("no start line in any form reads \"it did not say why\", and a kept ending (today's codes, or an earlier build's \"other\") is written again with a reason", () => {
    for (const why of START_FAILURE_CODES) {
      for (const line of [status("row_could_not_start", { name: canvas, why }), status("peer_could_not_start", { name: canvas, why }), status("delegated_turn_could_not_start", { why }), status("could_not_start", { why })]) {
        expect(outboundWords(line)).not.toMatch(/did not say why/);
      }
      expect(outboundWords(statusFromStored("delegated_turn_could_not_start", { why })!)).toMatch(/^Delegated turn could not start: /);
    }
    const legacy = statusFromStored("delegated_turn_could_not_start", { why: "other" });
    expect(legacy && outboundWords(legacy)).toBe("Delegated turn could not start: Murage could not set up its turn. Its conversation has the details");
    expect(statusFromStored("delegated_turn_could_not_start", { why: "some words" })).toBeUndefined();
  });
});

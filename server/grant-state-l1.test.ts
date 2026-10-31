// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 test 7 (gate tier): the state lane, section 4.2, with
// the choke point's deps stubbed. A crash is a throw at each boundary (or a
// new PendingGrants over the same file, which is what a restart reads);
// delivery outcomes are enumerated; live() turns false after delivery. After
// each case the active store and the pending journal hold exactly what they
// should. F13 and F16 live in grant-migrations-l1.test.ts, F18's fold in
// shared/fold-scopes.test.ts; F14 and F15 are L1b's.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RequestOutcome } from "./contracts.ts";
import { assertBotGrantAllowed } from "./approval-grant-routes.ts";
import { PendingGrants, RUN_ENDED, rememberAndAnswer, type GrantChokeDeps, type RememberInput } from "./grant-choke.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const KEY = "stop:delete:/Users/alex/site/build";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });

function lane(options: { outcome?: RequestOutcome | Error; failStage?: boolean; failDrop?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murage-l1a-state-")); dirs.push(dir);
  const file = join(dir, "pending.json");
  let failing: "stage" | "drop" | undefined;
  let saves = 0;
  const persist = (path: string, json: string) => {
    saves += 1;
    if ((failing === "stage" && saves === 1) || (failing === "drop" && saves === 2)) throw new Error("disk full");
    writeFileSync(path, json);
  };
  const pending = new PendingGrants(file, persist);
  failing = options.failStage ? "stage" : options.failDrop ? "drop" : undefined;
  const active: string[] = [];
  const inFlight = new Set<string>();
  const warned: unknown[] = [];
  const answer = vi.fn(async (_holder: unknown, threadId: string, requestId: string): Promise<RequestOutcome> => {
    inFlight.add(`${threadId}:${requestId}`);
    try {
      await Promise.resolve();
      const outcome = options.outcome ?? "allowed-once";
      if (outcome instanceof Error) throw outcome;
      return outcome;
    } finally { inFlight.delete(`${threadId}:${requestId}`); }
  });
  const deps: GrantChokeDeps = {
    cardOpen: () => true, holder: () => ({ kind: "engine", instanceId: "claude" }), inFlight: (flight) => inFlight.has(flight),
    pending, attempt: () => {}, answer, warn: (error) => warned.push(error),
  };
  const input = (extra: Partial<RememberInput<string[]>> = {}): RememberInput<string[]> => ({
    res: {}, threadId: "t-1", requestId: "r-1", answer: true, onComputer: true, holderId: "bot-a", botName: "Nova",
    row: { kind: "bot", ownerId: "bot-a" }, plan: () => [KEY], write: () => { active.push(KEY); return [...active]; }, ...extra,
  });
  const restart = () => new PendingGrants(file, (path, json) => writeFileSync(path, json));
  return { deps, input, active, pending, answer, warned, restart, inFlight };
}

describe("4.2: a grant mid-write, crash, restart, Stop", () => {
  it("F1: crash after stage, before delivery: swept at startup; the first press after says the bot stopped waiting", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = lane();
    w.pending.stage("t-1:r-1", { threadId: "t-1", requestId: "r-1", kind: "bot", ownerId: "bot-a", keys: [KEY], at: 1 });
    expect(w.restart().ids()).toEqual([]);
    const after = lane({ outcome: "unavailable" });
    expect(await rememberAndAnswer(after.deps, after.input())).toEqual({ ok: false, status: 409, error: "Nova stopped waiting for this. Ask it again.", answered: "unavailable" });
    expect(after.active).toEqual([]);
    expect(after.pending.ids()).toEqual([]);
  });

  it("F2: crash after delivery, before the write: no grant; the row is swept", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = lane();
    const crash = new Error("process died");
    await expect(rememberAndAnswer(w.deps, w.input({ write: () => { throw crash; } }))).resolves.toMatchObject({ ok: false, status: 500 });
    expect(w.answer).toHaveBeenCalledTimes(1);
    expect(w.active).toEqual([]);
    expect(w.restart().ids()).toEqual([]);
  });

  it("F3: plan fails (cap, refused key, no routine): 400/404 before anything is delivered", async () => {
    const w = lane();
    for (const status of [400, 404, 409]) {
      const decided = await rememberAndAnswer(w.deps, w.input({ plan: () => { throw Object.assign(new Error("Nova already keeps 200 things"), { status }); } }));
      expect(decided).toMatchObject({ ok: false, status });
    }
    expect(w.answer).not.toHaveBeenCalled();
    expect(w.pending.ids()).toEqual([]);
  });

  it("F4: the stage write fails: 500 before delivery, nothing delivered", async () => {
    const w = lane({ failStage: true });
    expect(await rememberAndAnswer(w.deps, w.input())).toMatchObject({ ok: false, status: 500, error: expect.stringMatching(/^Nothing was saved/) });
    expect(w.answer).not.toHaveBeenCalled();
    expect(w.active).toEqual([]);
  });

  it("F5: delivery throws: the row is dropped, the error reaches the route, nothing saved", async () => {
    const w = lane({ outcome: new Error("ApprovalDeliveryError") });
    await expect(rememberAndAnswer(w.deps, w.input())).rejects.toThrow("ApprovalDeliveryError");
    expect(w.pending.ids()).toEqual([]);
    expect(w.active).toEqual([]);
  });

  for (const outcome of ["rejected", "answered", "unavailable"] as const) {
    it(`F6: outcome ${outcome}: 409 with its own line, nothing saved`, async () => {
      const w = lane({ outcome });
      const decided = await rememberAndAnswer(w.deps, w.input());
      expect(decided).toMatchObject({ ok: false, status: 409, answered: outcome });
      expect(w.active).toEqual([]);
      expect(w.pending.ids()).toEqual([]);
    });
  }

  it("F7: the write throws: 500, allowed once, the grant not saved", async () => {
    const w = lane();
    const decided = await rememberAndAnswer(w.deps, w.input({ write: () => { throw new Error("disk full"); } }));
    expect(decided).toEqual({ ok: false, status: 500, error: "Allowed once. Always allow was not saved: disk full", answered: "allowed-once" });
    expect(w.pending.ids()).toEqual([]);
  });

  it("F8: crash after the write, before the reply: the grant is committed, the row swept", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = lane({ failDrop: true });
    const decided = await rememberAndAnswer(w.deps, w.input());
    expect(decided).toMatchObject({ ok: true, outcome: "allowed-once" });
    expect(w.active).toEqual([KEY]);
    // the drop failed: the row stays where no reader reads it, until the restart sweeps it
    expect(w.pending.ids()).toEqual(["t-1:r-1"]);
    expect(w.restart().ids()).toEqual([]);
    expect(w.active).toEqual([KEY]);
  });

  it("F9: the routine's run ended between delivery and the write: dropped, 409, nothing saved", async () => {
    const w = lane();
    let live = true;
    w.answer.mockImplementationOnce(async () => { live = false; return "allowed-once"; });
    const decided = await rememberAndAnswer(w.deps, w.input({ live: () => live }));
    expect(decided).toEqual({ ok: false, status: 409, error: RUN_ENDED, answered: "allowed-once" });
    expect(w.active).toEqual([]);
    expect(w.pending.ids()).toEqual([]);
  });

  it("F10, F11: a second press while the first is in delivery is refused; only the landed answer counts", async () => {
    const w = lane();
    const first = rememberAndAnswer(w.deps, w.input());
    const second = await rememberAndAnswer(w.deps, w.input());
    expect(second).toEqual({ ok: false, status: 409, error: "This request is being answered elsewhere, so nothing was saved." });
    expect(await first).toMatchObject({ ok: true });
    expect(w.active).toEqual([KEY]);
  });

  it("F12: a scope the class never offers or a key the rule refuses fails plan() before staging", async () => {
    const w = lane();
    const cases: [Parameters<typeof assertBotGrantAllowed>[0], string[]][] = [
      [{ allowKey: "stop:pay:stripe:x", taskAllowKey: "stop:pay:stripe:x" }, ["stop:pay:stripe:x"]],
      [{ allowKey: "Bash:git", routineId: "r1" }, ["Bash:git"]],
      [{ allowKey: "Bash:rm", cardClass: { reason: "destructive-guard", unattended: false, automated: false, keys: ["allowKey"] } }, ["Bash:rm"]],
    ];
    for (const [card, keys] of cases) {
      const decided = await rememberAndAnswer(w.deps, w.input({ plan: () => { assertBotGrantAllowed(card, keys, () => "Bills"); return keys; } }));
      expect(decided.ok).toBe(false);
      expect([400, 409]).toContain((decided as { status: number }).status);
    }
    expect(w.answer).not.toHaveBeenCalled();
    expect(w.pending.ids()).toEqual([]);
  });

  it("F17: a failed sweep or drop is warned, never thrown", async () => {
    const w = lane({ failDrop: true, outcome: "rejected" });
    expect(await rememberAndAnswer(w.deps, w.input())).toMatchObject({ ok: false, status: 409 });
    expect(w.warned).toHaveLength(1);
    expect(w.active).toEqual([]);
  });
});

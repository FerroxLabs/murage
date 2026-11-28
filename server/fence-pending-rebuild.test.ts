// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fence-pending-b, dispatch retry producer and pending-wait consumer.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Execute the production helper with the settlement boundary controlled. A
// false result without fresh owner input cannot admit a provider write.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const start = source.indexOf("async function rebuildRefusedDirectTurn(");
const end = source.indexOf("/** Ends a rebuild", start);
const js = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
it("direct recovery without fresh owner input does not rebuild when settlement fails", async () => {
  const settle = vi.fn(async () => false), admit = vi.fn(async () => "accepted");
  const rebuild = new Function("settleRevokesForTurn", "settleRefusedFence", "database", "directRuns", "memoryRefusalCauses", "freeThreadAfterRebuild", "markLastResort", js + ";return rebuildRefusedDirectTurn;")(
    settle, settle, () => ({}), { rebuilding: () => true }, new Map(), vi.fn(), vi.fn(),
  );
  const refusal = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { fence: { state: "checking", reason: "pending" } });
  const result = await rebuild({}, { held: () => true }, "message", { attempt: 1, lastResort: false }, admit, refusal, false);
  expect(settle).toHaveBeenCalledTimes(1);
  expect(admit).not.toHaveBeenCalled();
  expect(result).toEqual({ kind: "rejected", error: refusal });
});
it.each(["recallHeld", "recallReadmit"])("preserves %s recovery without a revoke wait", async flag => {
  const settle = vi.fn(async () => false), admit = vi.fn(async () => "accepted");
  const rebuild = new Function("settleRevokesForTurn", "settleRefusedFence", "database", "directRuns", "memoryRefusalCauses", "freeThreadAfterRebuild", "markLastResort", js + ";return rebuildRefusedDirectTurn;")(
    settle, settle, () => ({}), { rebuilding: () => true }, new Map(), vi.fn(), vi.fn(),
  );
  expect(await rebuild({ generation: "current" }, {}, "message", { attempt: 1, lastResort: false, [flag]: true }, admit, new Error("held"), false)).toEqual({ kind: "started" });
  expect(settle).not.toHaveBeenCalled();
  expect(admit).toHaveBeenCalledWith("current", 1);
});

it("direct recovery never waits on unrelated global revoke work", async () => {
  const globalQueue = vi.fn(async () => { throw new Error("unrelated revoke queue is held"); });
  const exact = vi.fn(async () => true), admit = vi.fn(async () => "accepted");
  const rebuild = new Function("settleRevokesForTurn", "settleDirectRefusal", "settleRefusedFence", "database", "directRuns", "memoryRefusalCauses", "freeThreadAfterRebuild", "markLastResort", js + ";return rebuildRefusedDirectTurn;")(
    globalQueue, globalQueue, exact, () => ({}), { rebuilding: () => true }, new Map(), vi.fn(), vi.fn(),
  );
  expect(await rebuild({ generation: "current" }, {}, "message", { attempt: 1, lastResort: false }, admit, new Error("MEMORY_CONTEXT_REVOKED"), false)).toEqual({ kind: "started" });
  expect(globalQueue).not.toHaveBeenCalled();
  expect(exact).toHaveBeenCalledOnce();
  expect(admit).toHaveBeenCalledWith("current", 1);
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: fence-pending-b, dispatch retry producer and pending-wait consumer.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

// Execute the production helper with the settlement boundary controlled. A
// false result must not consume another rebuild or admit a provider write.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const start = source.indexOf("async function rebuildRefusedDirectTurn(");
const end = source.indexOf("/** Ends a rebuild", start);
const js = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 });
it("direct recovery does not rebuild when settlement fails", async () => {
  const settle = vi.fn(async () => false), admit = vi.fn(async () => "accepted");
  const rebuild = new Function("settleRevokesForTurn", "settleRefusedFence", "database", "directRuns", "memoryRefusalCauses", "freeThreadAfterRebuild", "markLastResort", js + ";return rebuildRefusedDirectTurn;")(
    settle, settle, () => ({}), { rebuilding: () => true }, new Map(), vi.fn(), vi.fn(),
  );
  const refusal = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { fence: { state: "checking", reason: "pending" } });
  const result = await rebuild({}, { held: () => true }, "message", { lastResort: false }, admit, refusal);
  expect(settle).toHaveBeenCalledTimes(1);
  expect(admit).not.toHaveBeenCalled();
  expect(result).toEqual({ kind: "rejected", error: refusal });
});
it.each(["recallHeld", "recallReadmit"])("preserves %s recovery without a revoke wait", async flag => {
  const settle = vi.fn(async () => false), admit = vi.fn(async () => "accepted");
  const rebuild = new Function("settleRevokesForTurn", "settleRefusedFence", "database", "directRuns", "memoryRefusalCauses", "freeThreadAfterRebuild", "markLastResort", js + ";return rebuildRefusedDirectTurn;")(
    settle, settle, () => ({}), { rebuilding: () => true }, new Map(), vi.fn(), vi.fn(),
  );
  expect(await rebuild({ generation: "current" }, {}, "message", { lastResort: false, [flag]: true }, admit, new Error("held"))).toEqual({ kind: "started" });
  expect(settle).not.toHaveBeenCalled();
  expect(admit).toHaveBeenCalledWith("current");
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// INTEL-SMOKE-WORKER-EXIT: the helper hears a stop or a cancel only on a turn of the event loop, and a model call's
// promises settle without one. A long record gives the loop a turn between model calls.
import { expect, it } from "vitest";
import { MemoryEmbeddings } from "./embeddings.ts";

it("a long record lets the event loop turn between model calls", async () => {
  const embeddings = new MemoryEmbeddings("/unused", { model: "fixture", revision: "1", dimensions: 2, files: [] });
  let calls = 0;
  (embeddings as unknown as { extractor: unknown }).extractor = async (batch: string[]) => { calls++; return { tolist: () => batch.map(() => [1, 0]) }; };
  let callsAtFirstTurn = -1;
  setImmediate(() => { callsAtFirstTurn = calls; });
  await embeddings.embed([Array.from({ length: 4000 }, (_, i) => `word${i}`).join(" ")]);
  expect(calls).toBeGreaterThan(1);
  // Without a turn between calls the callback above has not run at all yet.
  expect(callsAtFirstTurn).toBeGreaterThanOrEqual(1);
  expect(callsAtFirstTurn).toBeLessThan(calls);
});

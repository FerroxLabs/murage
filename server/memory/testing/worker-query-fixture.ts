// SPDX-License-Identifier: AGPL-3.0-or-later
// Scheduling fixtures own the model/storage doubles; recall admission owns
// the production view. Keep the current binding on every scheduled query.
import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { MemorySearchInput } from "../worker-protocol.ts";

export const workerQueryAuthority = {
  view: { viewId: randomUUID(), generation: randomUUID(), digest: createHash("sha256").update("worker scheduling fixture").digest("hex") },
  reader: { botId: "fixture-bot", threadId: "fixture-thread", humanPrincipal: { personId: "fixture-owner", bindingId: "fixture-binding", revision: 0 }, notOwnerAudience: false },
} satisfies Pick<MemorySearchInput, "view" | "reader">;

export class WorkerQueryEligibility {
  validate(view: unknown, reader: unknown) {
    expect(view).toEqual(workerQueryAuthority.view);
    expect(reader).toEqual(workerQueryAuthority.reader);
  }
  read() { return { allowed: [], capacity: false }; }
  lexical() { return { hits: [] }; }
  warm() {}
  close() {}
}

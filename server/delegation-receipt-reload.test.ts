// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review round 7, R7-05: a receipt of how a delegation failed keeps its reason across a restart. The status key and its plain values are written
// with the receipt and read back with it, so a bot asking after the restart is told the same reason, not a plain "The request finished."
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveTaskSealed } from "./boundary-ports.ts";
import { DATA_DIR } from "./config.ts";
import { _loadPending, _resetPending, recordDelegationReceipt, findDelegationReceipt } from "./delegations.ts";
import { outboundWords, status } from "./murage-status.ts";

const deps = (id: string) => ({
  receipt: (taskId: string) => findDelegationReceipt(taskId), pending: () => null, request: () => null, requestSourceThread: () => null, watches: () => [] as never, delivered: "delivered", id,
});
const ended = (id: string) => {
  const resolved = resolveTaskSealed(id, undefined, deps(id));
  if (resolved?.kind !== "receipt") throw new Error("no receipt");
  return outboundWords(resolved.receipt.ended);
};
beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); });

describe("a failed delegation's reason survives a restart", () => {
  it("reads the same after the receipts are loaded again", () => {
    recordDelegationReceipt({ id: "t-reload", sourceThreadId: "src", toBotId: "b", toBotName: "Helper", status: "failed", result: status("delegated_turn_failed", { why: "auth" }), lineage: true });
    expect(ended("t-reload")).toBe("Delegated turn did not finish: it is not signed in to its provider");
    _loadPending();
    expect(ended("t-reload")).toBe("Delegated turn did not finish: it is not signed in to its provider");
  });
});

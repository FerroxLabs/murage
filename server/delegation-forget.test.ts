// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { _resetPending, findDelegationReceipt, forgetDelegationsForThreads, recordDelegationReceipt } from "./delegations.ts";

beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); _resetPending(); });

it("drops a deleted conversation's handoff results, and keeps the others", () => {
  recordDelegationReceipt({ id: "gone-1", sourceThreadId: "gone", toBotId: "b", toBotName: "B", status: "done", result: "private reply" });
  recordDelegationReceipt({ id: "kept-1", sourceThreadId: "kept", toBotId: "b", toBotName: "B", status: "done", result: "other reply" });
  forgetDelegationsForThreads(["gone"]);
  expect(findDelegationReceipt("gone-1")).toBeNull();
  expect(findDelegationReceipt("kept-1")?.result).toBe("other reply");
  const saved = readFileSync(join(DATA_DIR, "delegation-receipts.json"), "utf8");
  expect(saved).not.toContain("private reply");
  expect(saved).toContain("other reply");
});

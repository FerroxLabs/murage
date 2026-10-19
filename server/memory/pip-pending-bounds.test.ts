// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RC7 branch B (RC6-SPEED-DIAG.md 2d(ii)): the reflect "anything new" check reads the newest sources until the cursor, never the whole thread.
// Counted in payloads read, which does not depend on how long the thread is.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureMessage } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { admissibleOwnerSources, hasAdmissibleAfter } from "./pip-admission.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const T0 = 1_760_000_000_000;
const roster = { bots: [{ id: "moss", threadId: "private", tasks: [] as Array<{ threadId: string }> }], groups: [] as never[] };
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
  database().exec("PRAGMA synchronous=OFF");
});
afterEach(() => { setMemoryCaptureRoster(null); vi.restoreAllMocks(); });

function seed(count: number): void {
  const db = database();
  db.exec("BEGIN");
  for (let i = 1; i <= count; i++) {
    captureMessage(db, "private", { id: `o${i}`, at: T0 + i * 1000, role: "user", kind: "text", text: `Please be brief ${i}.`, origin: "desktop" } as never);
    captureMessage(db, "private", { id: `b${i}`, at: T0 + i * 1000 + 500, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  }
  db.exec("COMMIT");
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
}
const payloads = (q: Parameters<typeof hasAdmissibleAfter>[2]) => { let n = 0; const found = hasAdmissibleAfter(database(), "moss", q, () => { n++; }); return { found, n }; };

describe("the pending check reads a bounded number of payloads", () => {
  for (const count of [200, 800]) {
    it(`a thread of ${count} owner turns: cursor at the newest reads one payload and finds nothing new`, () => {
      seed(count);
      expect(payloads({ threadId: "private", afterAt: T0 + count * 1000, afterMessageId: `o${count}` })).toEqual({ found: false, n: 1 });
    });
    it(`a thread of ${count}: with the newest ten out of range, the eleventh payload is the answer`, () => {
      seed(count);
      const result = payloads({ threadId: "private", afterAt: T0 + (count - 12) * 1000, afterMessageId: `o${count - 12}`, untilAt: T0 + (count - 10) * 1000 });
      expect(result.found).toBe(true);
      expect(result.n).toBeLessThanOrEqual(11);
    });
    it(`a thread of ${count} with no cursor finds a source at the first payload`, () => {
      seed(count);
      expect(payloads({ threadId: "private" })).toEqual({ found: true, n: 1 });
    });
  }
  it("agrees with the full list on whether anything is admissible after the cursor", () => {
    seed(30);
    expect(admissibleOwnerSources(database(), "moss", { threadId: "private" }).length).toBe(30);
    for (const at of [0, 5, 29, 30]) {
      const q = at === 0 ? { threadId: "private" } : { threadId: "private", afterAt: T0 + at * 1000, afterMessageId: `o${at}` };
      expect(hasAdmissibleAfter(database(), "moss", q)).toBe(admissibleOwnerSources(database(), "moss", q).length > 0);
    }
  });
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from "vitest";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { claimMemoryJob } from "./jobs.ts";
import { maintainRecallViewSlice, stopRecallViewMaintenance } from "./recall-view.ts";
import { accessFor, freshDataDir, THREAD } from "./testing/recall-fixture.ts";

afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });

it("turn catch-up selects an eligible published job in one query while excluding the prompt and live leases", () => {
  freshDataDir("active");
  const { access } = accessFor();
  appendMessage(THREAD, { id: "older", at: 1, role: "user", kind: "text", text: "earlier fixture" });
  appendMessage(THREAD, { id: "prompt", parentId: "older", at: 2, role: "user", kind: "text", text: "current fixture" });
  while (!maintainRecallViewSlice(access.view)) { /* finish real projection before claiming */ }
  const db = database(), prepare = db.prepare;
  let probes = 0;
  db.prepare = function(sql) {
    if (sql.includes("AND NOT (s.thread_id=")) probes++;
    return prepare.call(this, sql);
  };
  try {
    const options = { exclude: { threadId: THREAD, messageIds: ["prompt"] } };
    expect(claimMemoryJob("fixture", Date.now(), access.view, options)?.sourceId).toBe(`message:${THREAD}:older`);
    expect(probes).toBe(1);
    probes = 0;
    expect(claimMemoryJob("fixture", Date.now(), access.view, options)).toBeNull();
    expect(probes).toBe(1);
  } finally { db.prepare = prepare; }
});

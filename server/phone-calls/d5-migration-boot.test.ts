// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../../scripts/control-murage.ts";
import { DatabaseSync } from "../sqlite-open.ts";
import { PHONE_KEY_ORIGIN, PHONE_SECRETS_ENV } from "./phone-secrets.ts";

// P8b on the production path: the server's own startup loop (index.ts startPhoneCalls) must pick up a migration
// that a killed process left at its committed 500-row cursor and finish it from there.
it("P8b a booted server resumes a crashed phone migration at the committed 500-row cursor", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: `
      process.env[${JSON.stringify(PHONE_SECRETS_ENV)}] = ${JSON.stringify(JSON.stringify({ key: "fixture", origin: PHONE_KEY_ORIGIN }))};
      const { appendFileSync } = await import("node:fs");
      const { DatabaseSync } = await import("node:sqlite");
      const file = process.env.MURAGE_DATA_DIR + "/phone-calls.db";
      const legacy = new DatabaseSync(file);
      legacy.exec("CREATE TABLE phone_calls (id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, revision INTEGER NOT NULL, assistant_id TEXT NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, row_json TEXT NOT NULL); CREATE INDEX phone_calls_live ON phone_calls(status) WHERE status IN ('uncertain', 'scheduled', 'ringing', 'in_progress'); BEGIN");
      const put = legacy.prepare("INSERT INTO phone_calls VALUES (?, '', 1, 'assistant', ?, 'ended', ?)");
      for (let n = 1; n <= 10000; n++) put.run("historic-" + n, n, JSON.stringify({ id: "historic-" + n, createdAt: n, vendorId: "", revision: 1,
        assistantId: "assistant", status: "ended", language: "en", to: "", goal: "", details: "", limits: "" }));
      legacy.exec("COMMIT");
      legacy.close();
      const { SqliteCallStore } = await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
      // The state a process killed right after its first committed batch leaves behind.
      const crashed = new DatabaseSync(file);
      new SqliteCallStore(crashed).migrateBatch();
      crashed.close();
      const batch = SqliteCallStore.prototype.migrateBatch;
      SqliteCallStore.prototype.migrateBatch = function () {
        appendFileSync(process.env.MURAGE_DATA_DIR + "/phone-migrate-batches", "batch\\n");
        return batch.call(this);
      };
    `,
  });
  try {
    const file = join(fixture.info.dataDir, "phone-calls.db");
    const counted = join(fixture.info.dataDir, "phone-migrate-batches");
    const read = () => {
      const db = new DatabaseSync(file, { readOnly: true, timeout: 10_000 });
      try {
        const meta = db.prepare("SELECT value FROM phone_call_meta WHERE key = 'migrated'").get() as { value: string } | undefined;
        const keys = db.prepare("SELECT count(*) AS n FROM phone_call_keys").get() as { n: number };
        return { finished: meta?.value, keys: keys.n };
      } finally { db.close(); }
    };
    const deadline = Date.now() + 20_000;
    let state = read();
    while (state.finished !== "done" && Date.now() < deadline) { await pause(100); state = read(); }
    await pause(300);
    const batches = existsSync(counted) ? readFileSync(counted, "utf8").split("\n").filter(Boolean).length : 0;
    // Crash-resume assertion (P8b, production loop): 19 full batches from rowid 501 plus the final empty one.
    expect({ ...read(), batches }).toEqual({ finished: "done", keys: 10_000, batches: 20 });
  } finally {
    await fixture.close();
  }
}, 90_000);

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { OWNER_PIN_INDEX } from "./schema.ts";
import { MEMORY_UPGRADE_STATUS_FILE } from "./upgrade-status.ts";

let fixture: VerificationServer | undefined;
afterEach(async () => { await fixture?.close(); closeDatabase(); });

it("the real server completes the missing pin index under its note before listening on an isolated data copy", { timeout: 180_000 }, async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const snapshot = join(DATA_DIR, "boot-copy.db");
  database().exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import { copyFileSync, readFileSync, appendFileSync } from "node:fs";
    import { join } from "node:path";
    import { DatabaseSync } from "node:sqlite";
    import { Server } from "node:net";
    const dir = process.env.MURAGE_DATA_DIR;
    const file = join(dir, "messages.db");
    const record = event => appendFileSync(join(dir, "boot-order.jsonl"), JSON.stringify(event) + "\\n");
    copyFileSync(${JSON.stringify(snapshot)}, file);
    const copy = new DatabaseSync(file);
    copy.exec(${JSON.stringify(`DROP INDEX ${OWNER_PIN_INDEX}`)});
    copy.close();
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      const pin = /CREATE INDEX IF NOT EXISTS ${OWNER_PIN_INDEX}\\b/.test(sql);
      if (pin) {
        // Hold the serving thread as a slow index build does; the independent note writer can still run.
        let phase;
        const deadline = Date.now() + 2000;
        const sleeper = new Int32Array(new SharedArrayBuffer(4));
        do {
          try { phase = JSON.parse(readFileSync(join(dir, ${JSON.stringify(MEMORY_UPGRADE_STATUS_FILE)}), "utf8")).upgrade?.phase; } catch {}
          if (phase === "indexing") break;
          Atomics.wait(sleeper, 0, 0, 10);
        } while (Date.now() < deadline);
        record({ event: "build-start", phase });
      }
      const result = exec.call(this, sql);
      if (pin) record({ event: "build-end" });
      return result;
    };
    const listen = Server.prototype.listen;
    Server.prototype.listen = function(...args) {
      const check = new DatabaseSync(file, { readOnly: true });
      const present = !!check.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(${JSON.stringify(OWNER_PIN_INDEX)});
      check.close();
      record({ event: "listen", present });
      return listen.apply(this, args);
    };
  ` });
  const events = readFileSync(join(fixture.info.dataDir, "boot-order.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  console.log(JSON.stringify({ events, logPath: fixture.info.logPath }));
  const start = events.findIndex(row => row.event === "build-start");
  const end = events.findIndex(row => row.event === "build-end");
  const listen = events.findIndex(row => row.event === "listen");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(events[start].phase).toBe("indexing");
  expect(end).toBeGreaterThan(start);
  expect(listen).toBeGreaterThan(end);
  expect(events.filter(row => row.event === "listen").every(row => row.present)).toBe(true);
});

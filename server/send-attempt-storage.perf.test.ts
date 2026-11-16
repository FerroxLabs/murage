import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initializeSendAttempts } from "./send-attempt-state.ts";

it("F7-STORAGE: measure payload-free receipt, action and retirement growth", () => {
  const scales = process.env.L8_STORAGE_FULL === "1" ? [1_000, 100_000, 1_000_000] : [1_000];
  for (const count of scales) {
    const dir = mkdtempSync(join(tmpdir(), "l8-storage-")); const file = join(dir, "messages.sqlite");
    const db = new DatabaseSync(file); db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0"); initializeSendAttempts(db);
    const attempt = db.prepare(`INSERT INTO send_attempts VALUES (?, 'owner','bot','thread',?,'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',0,0,'terminal','not_submitted','exclude',4,1,NULL,NULL,?,?,'failed',NULL,1,0,1,1)`);
    const binding = db.prepare("INSERT INTO send_attempt_bindings VALUES (?,1,?,'instance',NULL,NULL,0,0,1,0,'thread')");
    const exclusion = db.prepare("INSERT INTO send_replay_exclusions VALUES ('thread',?,?,'not_submitted',4)");
    const action = db.prepare("INSERT INTO send_actions VALUES ('owner',?,'bot','thread','resend',?,4,1,NULL,'hash',NULL,NULL,?,?,'done','accepted',1)");
    const fence = db.prepare("INSERT INTO retired_send_ids VALUES ('key',1,?,'send',1)");
    const start = performance.now();
    let walPeak = 0;
    for (let from = 0; from < count; from += 1_000) {
      db.exec("BEGIN IMMEDIATE");
      for (let i = from; i < Math.min(from + 1_000, count); i++) {
        const id = i.toString(16).padStart(36, "0"); attempt.run(id, `s-${id}`, `m-${id}`, `q-${id}`); binding.run(id, `g-${id}`); exclusion.run(`m-${id}`, id); action.run(`a-${id}`, id, `r-${id}`, `rs-${id}`); fence.run(i.toString(16).padStart(64, "0"));
      }
      db.exec("COMMIT"); walPeak = Math.max(walPeak, statSync(`${file}-wal`).size);
      // Bound physical WAL during the million-row measurement, recording peak
      // before every checkpoint; do not hide WAL in the size estimate.
      if (from % 10_000 === 0) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = statSync(file).size;
    console.log(JSON.stringify({ name: "F7-STORAGE", count, dbBytes: bytes, walPeakBytes: walPeak, bytesPerAttemptActionFence: bytes / count, seconds: (performance.now() - start) / 1_000, yearAt100AttemptsPerDayBytes: bytes / count * 36_500 }));
    expect(db.prepare("SELECT count(*) AS n FROM send_attempts").get()).toEqual({ n: count });
    expect(db.prepare("PRAGMA table_info(send_attempts)").all().map(row => row.name)).not.toContain("text");
    db.close();
  }
}, 600_000);

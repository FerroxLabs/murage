// q1022-disk item 7, production store open: the real server (index.ts) opens the connected-app store at start-up
// (rebuildOwedCards -> cardsOwed -> appTriggerStore(), index.ts:41585 and :19679), and that open prunes settled history
// older than 30 days. Aged rows are seeded into the server's own messages.db between two boots, in the shape the
// delivery leaves them (custody acknowledged, batch sealed, run settled); nothing in the server is stubbed.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { bodyDigest } from "../shared/app-trigger-canonical.mjs";
import { AppTriggerStore } from "./app-trigger-store.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { childEnv } from "./testing/murage-env.mjs";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const SUB = "754ff2fc-423d-5573-bded-ccf9fb7cde23", BILL = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const DAY = 86_400_000;

function seedRun(d: DatabaseSync, id: string, at: number) {
  const batch = `b-${id}`;
  d.prepare("INSERT INTO app_event_batches (batch_id,trigger_id,state,opened_at,seal_due_at,member_count,member_bytes,run_id) VALUES (?,?,?,?,?,?,?,?)")
    .run(batch, "trg-1", "sealed", at, at + 30_000, 2, 20, id);
  for (let p = 0; p < 2; p++) {
    const del = `d-${id}-${p}`;
    d.prepare(`INSERT INTO app_event_inbox (delivery_id,owner_account_id,trigger_id,subscription_id,source_key,event_type,occurred_at,deadline_at,catch_up,digest,projection,bytes,disposition,claim_id,acked,received_at)
      VALUES (?,?,?,?,?,?,?,?,0,?,?,?, 'batched','c',1,?)`).run(del, "acct_owner_a", "trg-1", SUB, `slack:${del}`, "slack.channel.message", new Date(at).toISOString(),
      new Date(at + DAY).toISOString(), bodyDigest(del), JSON.stringify({ text: "x".repeat(400) }), 410, at);
    d.prepare("INSERT INTO app_event_run_events (batch_id,delivery_id,position) VALUES (?,?,?)").run(batch, del, p);
  }
  d.prepare(`INSERT INTO app_event_runs (run_id,batch_id,trigger_id,routine_id,bot_id,owner_account_id,subscription_id,policy_digest,billing_ref,state,thread_id,child_refusal,child_card_written,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'completed',NULL,NULL,0,?,?)`).run(id, batch, "trg-1", "r-1", "bot-a", "acct_owner_a", SUB, bodyDigest("policy"), BILL, at, at);
}

describe.skipIf(process.platform === "win32")("app-event history at server start", () => {
  let child: ChildProcess | undefined;
  const home = mkdtempSync(join(tmpdir(), "murage-appprune-"));
  afterAll(async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); await removeTempDir(home); });

  async function boot() {
    const port = await freePortBlock([0, 1], 19_700, 200);
    let stdout = "", stderr = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: join(SERVER_DIR, ".."), stdio: ["ignore", "pipe", "pipe"],
      env: childEnv({ HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_TURN_TRACE: "1" }),
    });
    child.stdout!.on("data", chunk => (stdout += chunk));
    child.stderr!.on("data", chunk => (stderr += chunk));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server start-up never finished. stderr:\n${stderr.slice(-4000)}`)), 90_000);
      const ready = () => { if (stdout.includes("phase=startup.deferred.done")) { clearTimeout(timer); resolve(); } };
      child!.stdout!.on("data", ready);
      child!.once("exit", () => { clearTimeout(timer); reject(new Error(`server exited during start-up. stderr:\n${stderr.slice(-4000)}`)); });
    });
    await waitForExit(child, { signal: "SIGTERM" });
    child = undefined;
  }

  it("Q22DISK-APP the store open at server start removes settled app-event history older than 30 days", async () => {
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {} }));
    await boot(); // creates the real data folder and messages.db
    const db = new DatabaseSync(join(home, ".murage", "messages.db"));
    new AppTriggerStore(db); // its tables, as the server's own open made them (CREATE IF NOT EXISTS)
    const now = Date.now();
    for (let i = 0; i < 10; i++) seedRun(db, `old-${i}`, now - 45 * DAY + i * 60_000);
    seedRun(db, "young", now - 10 * DAY);
    db.close();
    await boot(); // the second start opens the store; nothing else in it writes app-event rows
    const after = new DatabaseSync(join(home, ".murage", "messages.db"), { readOnly: true });
    const n = (table: string) => Number((after.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    const left = { runs: n("app_event_runs"), batches: n("app_event_batches"), members: n("app_event_run_events"), inbox: n("app_event_inbox") };
    after.close();
    expect(left, "Q22DISK-APP settled history left after a server start").toEqual({ runs: 1, batches: 1, members: 2, inbox: 2 });
  }, 240_000);
});

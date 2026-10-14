// Astra r22 finding 5, closed: the REAL Murage 1.0.1 server (git archive d950cbf67, extracted into the gitignored .v101-ref directory) boots from the folder that
// "Prepare to reinstall Murage 1.0.1" leaves behind while ANOTHER turn keeps the target busy during the first drain. A room hand-off whose start 1.0.2 had cut
// short before the provider is exported as queued, and its request must be where 1.0.1 expects a waiting hand-off's: queued. Left running, 1.0.1's own boot sweep
// marks it unknown and cancels the hand-off without ever running it. Test data only (fake engine, throwaway data folders). Run in the build host container (hz-test.sh).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { insertRoomRequest, markRequestDispatched } from "./room-requests.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const V101 = join(process.cwd(), ".v101-ref");
const have101 = existsSync(join(V101, "scripts", "control-murage.ts")) && existsSync(join(V101, "server", "index.ts"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HOLD = "__fixture_hold_authority__";

type Turn = { pid: number };
async function turnFor(fixture: VerificationServer, tag: string, ms = 90_000): Promise<Turn> {
  for (const started = Date.now(); Date.now() - started < ms; await sleep(150)) {
    try { const text = readFileSync(fixture.fixtureDumpPath, "utf8"); if (text.includes(tag)) return withTurnSecrets(JSON.parse(text)) as Turn; } catch { /* not yet */ }
  }
  throw new Error(`no turn for ${tag}`);
}

describe.skipIf(!have101 || process.platform === "win32")("the real 1.0.1 server runs a started-but-unsubmitted room hand-off while its target is busy", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => { for (const close of closers) await close().catch(() => {}); });

  it("the exported hand-off's request stays queued through 1.0.1's boot sweep, and the hand-off runs once after the busy turn ends", async () => {
    const a = await launchVerificationServer(process.env);
    closers.push(() => a.close());
    const secret = (await (await fetch(`${a.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${a.info.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...desktop }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    const asker = (await post("/api/bots", { name: "Asker" })).body.bot as { id: string; threadId: string };
    const peer = (await post("/api/bots", { name: "Peer" })).body.bot as { id: string; threadId: string };
    await a.stop();

    // ── 1.0.2's database: a queued hand-off that will keep the peer busy (A), and a room hand-off whose start was cut short before the provider (B) ──
    const db = new DatabaseSync(join(a.info.dataDir, "messages.db"));
    try {
      const insert = db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, started_at, start_attempts, target_thread_id, item, origin, turn_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
      insert.run("busy-a", asker.threadId, peer.id, asker.id, "fresh", null, null, null, JSON.stringify({ message: `Keep busy. BUSY_A ${HOLD}`, depth: 0, attempts: 0 }), "owner", "dlg-busy-a");
      insertRoomRequest(db, { id: "busy-b", groupId: "g", verb: "ask", fromKind: "bot", fromBotId: asker.id, toBotId: peer.id, returnThreadId: asker.threadId, returnBotId: asker.id, admissionKey: "ask:delegation:busy-b", now: Date.now(),
        lineage: { rootThreadId: asker.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } });
      expect(markRequestDispatched(db, "busy-b", { now: Date.now(), targetThreadId: peer.threadId })).toBe(true);
      insert.run("busy-b", asker.threadId, peer.id, asker.id, "started", Date.now(), 1, peer.threadId, JSON.stringify({ message: "Second hand-off. BUSY_B", depth: 0, attempts: 0 }), "room", "dlg-busy-b");
      expect(db.prepare("SELECT state FROM room_requests WHERE id='busy-b'").get()).toMatchObject({ state: "running" });
    } finally { db.close(); }

    // ── the step "Prepare to reinstall Murage 1.0.1" ──
    const result = downgradeInstallationMemorySchema(a.info.dataDir, 6) as { handoffs?: number };
    expect(result.handoffs).toBe(2);
    const exported = new DatabaseSync(join(a.info.dataDir, "messages.db"), { readOnly: true });
    try { expect(exported.prepare("SELECT state FROM room_requests WHERE id='busy-b'").get()).toMatchObject({ state: "queued" }); } finally { exported.close(); }

    // ── 1.0.1: a fresh fixture of the real tag, its data folder replaced by the downgraded one, then started ──
    const specifier = "../.v101-ref/scripts/control-murage.ts";            // a variable: the type check never reads the 1.0.1 tree
    const control = await import(/* @vite-ignore */ specifier) as { launchVerificationServer: typeof launchVerificationServer };
    const b = await control.launchVerificationServer(process.env);
    closers.push(() => b.close());
    await b.stop();
    const keep = new Set(["config.json", "whats-new.json", "terms-acceptance.json", "tmp", "finish-fake", "fake-claude-dump.json", "bx-run"]);
    for (const name of readdirSync(b.info.dataDir)) if (/^messages\.db/.test(name)) rmSync(join(b.info.dataDir, name), { force: true });
    mkdirSync(join(b.info.dataDir, "tmp"), { recursive: true });
    for (const name of readdirSync(a.info.dataDir)) {
      if (keep.has(name) || /lease|\.lock$|\.sock$/i.test(name)) continue;
      cpSync(join(a.info.dataDir, name), join(b.info.dataDir, name), { recursive: true });
    }
    writeFileSync(b.fixtureDumpPath, "");
    await b.restart();

    const first = await turnFor(b, "BUSY_A");                              // the first drain started A: the peer is busy, so B waits for it
    await sleep(2500);                                                      // 1.0.1's boot sweep and the first retries have run by now
    const mid = new DatabaseSync(join(b.info.dataDir, "messages.db"), { readOnly: true });
    try { expect(mid.prepare("SELECT state FROM room_requests WHERE id='busy-b'").get()).toMatchObject({ state: "queued" }); } finally { mid.close(); }
    expect(readFileSync(b.fixtureDumpPath, "utf8")).not.toContain("BUSY_B");

    writeFileSync(join(b.fixtureFinishGateDir, String(first.pid)), "finish");   // A ends: the peer is free
    await turnFor(b, "BUSY_B");                                             // B runs, once
    const check = new DatabaseSync(join(b.info.dataDir, "messages.db"), { readOnly: true });
    try {
      expect((check.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='user' AND text LIKE '%BUSY_B%'").get() as { n: number }).n).toBe(1);
      expect(check.prepare("SELECT state FROM room_requests WHERE id='busy-b'").get()).not.toMatchObject({ state: "unknown" });
    } finally { check.close(); }
    const receiptsFile = join(b.info.dataDir, "delegation-receipts.json");
    const receipts = existsSync(receiptsFile) ? JSON.parse(readFileSync(receiptsFile, "utf8")) as Array<{ id: string; status: string }> : [];
    expect(receipts.filter((r) => r.id === "busy-b" && r.status === "cancelled")).toEqual([]);
    expect(readFileSync(b.info.logPath, "utf8")).not.toMatch(/DATABASE_SCHEMA_UNSUPPORTED|SqliteError/);
  }, 600_000);
});

// Astra r21 finding 6, resolved within DESIGN-r22.md item 8: the REAL Murage 1.0.1 server (git archive d950cbf67, extracted into the gitignored
// .v101-ref directory of this worktree) boots from the data folder that "Prepare to reinstall Murage 1.0.1" leaves behind, loads delegations.json and
// runs the waiting hand-off exactly once. Test data only (fake engine, throwaway data folders). Run in the build host container (hz-test.sh), never on a Mac.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { withTurnSecrets } from "./testing/fixture-dump.ts";

const V101 = join(process.cwd(), ".v101-ref");
const have101 = existsSync(join(V101, "scripts", "control-murage.ts")) && existsSync(join(V101, "server", "index.ts"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HOLD = "__fixture_hold_authority__";

type Turn = { pid: number; mcpConfig?: { mcpServers?: Record<string, { env?: Record<string, string> }> } };
async function turnFor(fixture: VerificationServer, tag: string, ms = 60_000): Promise<Turn> {
  for (const started = Date.now(); Date.now() - started < ms; await sleep(150)) {
    try { const text = readFileSync(fixture.fixtureDumpPath, "utf8"); if (text.includes(tag)) return withTurnSecrets(JSON.parse(text)) as Turn; } catch { /* not yet */ }
  }
  throw new Error(`no turn for ${tag}`);
}
const tokenOf = (turn: Turn) => Object.values(turn.mcpConfig?.mcpServers ?? {}).map((server) => server.env?.MURAGE_COMMS_TOKEN).find(Boolean)!;

describe.skipIf(!have101 || process.platform === "win32")("the real 1.0.1 server boots from a downgraded data folder", () => {
  const closers: Array<() => Promise<void>> = [];
  afterAll(async () => { for (const close of closers) await close().catch(() => {}); });

  it("starts, loads delegations.json, runs the queued hand-off once and keeps the interrupted receipt", async () => {
    expect((JSON.parse(readFileSync(join(V101, "package.json"), "utf8")) as { version: string }).version).toBe("1.0.1");
    // ── 1.0.2: a hand-off queued behind a held turn, plus one whose turn the provider had taken ──
    const a = await launchVerificationServer(process.env);
    closers.push(() => a.close());
    const secret = (await (await fetch(`${a.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const post = async (path: string, body: unknown, headers: Record<string, string> = desktop) => {
      const response = await fetch(`${a.info.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    const asker = (await post("/api/bots", { name: "Asker" })).body.bot as { id: string; threadId: string };
    const peer = (await post("/api/bots", { name: "Peer" })).body.bot as { id: string; threadId: string };
    await post(`/api/bots/${asker.id}/messages`, { text: `Hold on. ${HOLD} ASKER_HOLD` });
    const token = tokenOf(await turnFor(a, "ASKER_HOLD"));
    const queued = await post("/api/internal/delegate-bot", { fromBotId: asker.id, fromThreadId: asker.threadId, toBotId: peer.id, message: `Pass this on. BOOT101_TAG ${HOLD}` }, { authorization: `Bearer ${token}` });
    expect(queued.body.queued, JSON.stringify(queued.body)).toBe(true);
    await a.stop();
    const db = new DatabaseSync(join(a.info.dataDir, "messages.db"));
    try {
      const waiting = db.prepare("SELECT id, phase, origin FROM pending_delegations").all() as Array<{ id: string; phase: string; origin: string }>;
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ phase: "fresh", origin: "owner" });
      db.prepare("INSERT INTO pending_delegations(id, source_thread_id, to_bot_id, from_bot_id, phase, started_at, accepted_turn_id, start_attempts, item, origin, turn_key, target_thread_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("taken-1", asker.threadId, peer.id, asker.id, "started", Date.now(), "turn-3", 1, JSON.stringify({ message: "already running", depth: 0, attempts: 0 }), "owner", "dlg-taken-1", peer.threadId);
    } finally { db.close(); }

    // ── the step "Prepare to reinstall Murage 1.0.1" ──
    const result = downgradeInstallationMemorySchema(a.info.dataDir, 6) as { handoffs?: number; handoffsStarted?: number };
    expect(result).toMatchObject({ handoffs: 1, handoffsStarted: 1 });
    expect(JSON.parse(readFileSync(join(a.info.dataDir, "delegation-receipts.json"), "utf8"))).toEqual([expect.objectContaining({ id: "taken-1", result: "interrupted by the reinstall" })]);

    // ── 1.0.1: a fresh fixture of the real tag, its data folder replaced by the downgraded one, then started again ──
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
    expect(existsSync(join(b.info.dataDir, "delegations.json"))).toBe(true);
    writeFileSync(b.fixtureDumpPath, "");
    await b.restart();                                                    // the real 1.0.1 server starts on the downgraded folder

    const drained = await turnFor(b, "BOOT101_TAG");                      // it loaded delegations.json and ran the hand-off
    const check = new DatabaseSync(join(b.info.dataDir, "messages.db"), { readOnly: true });
    try {
      const prompts = check.prepare("SELECT COUNT(*) AS n FROM messages WHERE role='user' AND text LIKE '%BOOT101_TAG%'").get() as { n: number };
      expect(prompts.n).toBe(1);
      expect(check.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name IN ('pending_delegations','owner_sends','restore_holds')").get()).toBeUndefined();
    } finally { check.close(); }
    const log = readFileSync(b.info.logPath, "utf8");
    expect(log).not.toMatch(/DATABASE_SCHEMA_UNSUPPORTED|MEMORY_SCHEMA_NEWER|SqliteError/);
    writeFileSync(join(b.fixtureFinishGateDir, String(drained.pid)), "finish");
    // exactly one turn: a short wait for a second one that must not come
    await sleep(3000);
    const dump = readFileSync(b.fixtureDumpPath, "utf8");
    expect((dump.match(/BOOT101_TAG/g) ?? []).length).toBeGreaterThan(0);
  }, 600_000);
});

// A refusal caused by a policy move that denies a memory rebuilds the turn on a bundle that leaves the denied memory out.
// Through the real server and a fake pi engine that records every prompt: two pinned records are in the bot's memory, the turn is held at the
// provider handshake (dispatched, not accepted), the roster moves and one record becomes denied (withheld: deny-memory), then acceptance refuses
// the held turn. The rebuild resolves memory under the moved revision: the allowed record is delivered, the denied record is in no prompt and in
// no disclosure row written after the move.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-pi-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");
let fixture: VerificationServer, headers: Record<string, string>, gate: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const botState = async (id: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
const dumpRows = (): any[] => { const file = join(fixture.info.dataDir, "pi-dump.jsonl"); return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []; };

posixOnly("a policy move that denies a memory, then a refused held turn", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.piGate={driver:'piAgent',displayName:'Gated pi fixture',config:{cli:${JSON.stringify(FAKE_PI)},fullAuto:true},
        environment:{FAKE_PI_SESSION_GATE:path.join(process.env.MURAGE_DATA_DIR,'pi-session-gate'),FAKE_PI_DUMP:path.join(process.env.MURAGE_DATA_DIR,'pi-dump.jsonl')}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    gate = join(fixture.info.dataDir, "pi-session-gate");
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it("the rebuilt bundle and every disclosure row after the move leave the denied memory out, and keep the allowed one", async () => {
    const models = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "piGate").models.options;
    const created = await api("POST", "/api/bots", { name: "Denied memory fixture", modelSelection: { instanceId: "piGate", model: models[0].id } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
    const ALLOWED = "ALLOWED-PIN-fixture-4417", DENIED = "DENIED-PIN-fixture-8820";
    const writer = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
    try {
      writer.exec("PRAGMA busy_timeout=5000");
      const scope = writer.prepare("SELECT id FROM memory_scopes WHERE kind='bot' AND owner_key=?").get(bot.id) as { id: string } | undefined;
      expect(scope).toBeTruthy();
      const pin = writer.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',1,?,NULL,NULL,?)");
      pin.run("pin-allowed", scope!.id, `The allowed fixture code is ${ALLOWED}.`, Date.now(), Date.now());
      pin.run("pin-denied", scope!.id, `The denied fixture code is ${DENIED}.`, Date.now(), Date.now());
      writer.exec("UPDATE memory_meta SET data_revision=data_revision+1");
      const policyRevision = () => Number((writer.prepare("SELECT policy_revision FROM memory_meta WHERE id=1").get() as { policy_revision: number }).policy_revision);
      const disclosures = () => writer.prepare("SELECT bundle_id,state,policy_revision,record_versions FROM memory_disclosures WHERE thread_id=? ORDER BY created_at,rowid").all(bot.threadId) as Array<{ bundle_id: string; state: string; policy_revision: number; record_versions: string }>;
      const promptsSent = () => dumpRows().filter(row => row.prompt).map(row => String(row.message));

      // The turn is held at the provider handshake: dispatched, not accepted.
      rmSync(gate, { force: true }); rmSync(`${gate}.waiting`, { force: true });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "what are the fixture codes?" })).status).toBe(202);
      await expect.poll(() => existsSync(`${gate}.waiting`), { timeout: 15000 }).toBe(true);
      const revisionAtDispatch = policyRevision();
      const before = disclosures();
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ state: "prepared", policy_revision: revisionAtDispatch });
      // the bundle prepared before the move had both memories, so the move is the only reason the denied one can be absent
      expect(before[0]!.record_versions).toContain("pin-denied");
      expect(before[0]!.record_versions).toContain("pin-allowed");

      // The roster moves and the owner's denial of one memory lands inside the window.
      writer.prepare("INSERT INTO memory_deny_object(kind,id,version,revoke_id) VALUES('record','pin-denied',0,1)").run();
      writer.exec("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'");
      expect((await api("PATCH", `/api/bots/${bot.id}`, { section: "Moved with a denial" })).status).toBe(200);
      expect(policyRevision()).toBeGreaterThan(revisionAtDispatch);
      writeFileSync(gate, "");

      await expect.poll(() => readFileSync(fixture.info.logPath, "utf8").includes(`[memory] context revoked during dispatch on thread ${bot.threadId}`), { timeout: 15000 }).toBe(true);
      await expect.poll(async () => (await botState(bot.id)).busy, { timeout: 20000 }).toBe(false);
      await expect.poll(() => promptsSent().length, { timeout: 15000 }).toBeGreaterThan(0);

      // the rebuilt prompt carries the allowed memory and none of the denied one
      const sent = promptsSent().join("\n");
      expect(sent).toContain(ALLOWED);
      expect(sent).not.toContain(DENIED);
      // every disclosure row written after the move: the allowed memory is delivered, the denied one is in none
      const rebuilt = disclosures().filter(row => !before.some(old => old.bundle_id === row.bundle_id));
      expect(rebuilt.length).toBeGreaterThan(0);
      expect(rebuilt.filter(row => row.state === "delivered").some(row => row.record_versions.includes("pin-allowed"))).toBe(true);
      for (const row of rebuilt) { expect(row.policy_revision).toBe(policyRevision()); expect(row.record_versions).not.toContain("pin-denied"); }
      // the pre-move bundle was revoked, never delivered
      expect(disclosures().find(row => row.bundle_id === before[0]!.bundle_id)?.state).toBe("revoked");
      // and no tool surface or any other row of the thread's messages carries the denied text
      const thread = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).body.messages as any[];
      expect(JSON.stringify(thread)).not.toContain(DENIED);
    } finally { writer.close(); }
  }, 90000);
});

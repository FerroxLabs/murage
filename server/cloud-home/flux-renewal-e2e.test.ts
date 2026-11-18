// SPDX-License-Identifier: AGPL-3.0-or-later
// B4 hole 11, end to end: the REAL poller code (deploy/cloud-home/murage-control, run by python3 -I) talks over
// real HTTP to the REAL control-plane handler (cloudflare/control-plane/src/b4-flux.ts) on an in-memory SQLite
// database carrying every real migration. No request or response is hand-written on either side.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { completeFluxSubkey, peekFluxSubkey } from "./flux-subkey-delivery.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const program = join(here, "../../deploy/cloud-home/murage-control");
const migrations = join(here, "../../cloudflare/control-plane/migrations");
const cpSource = join(here, "../../cloudflare/control-plane/src");
const HOME = "home-e2e", OWNER = "owner-e2e", TOKEN = "machine-credential-for-e2e-0123456789", IP = "203.0.113.7", DAY = 86_400_000; // secret-scan: fixture
const NOW = Date.parse("2026-10-09T12:00:00Z");

/** A D1 look-alike over node:sqlite: the methods the control plane uses, with D1's result shapes. */
function d1(db: DatabaseSync) {
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async (column?: string) => { const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined; return row === undefined ? null : column ? row[column] : { ...row }; },
    run: async () => {
      // D1 returns a RETURNING statement's rows from run() and batch() too.
      if (/\breturning\b/i.test(sql)) { const results = (db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map(row => ({ ...row })); return { success: true, results, meta: { changes: results.length } }; }
      return { success: true, results: [], meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) } };
    },
    all: async () => ({ success: true, results: (db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[]).map(row => ({ ...row })) }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      db.exec("BEGIN");
      try { const out = []; for (const item of statements) out.push(await item.run()); db.exec("COMMIT"); return out; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}

interface Mint { generation: number }
let controlNow = NOW;
let db: DatabaseSync, server: Server, port = 0, minted: Mint[] = [], acks = 0;
let fluxRoute: (request: Request, env: never, auth: never, deps: never) => Promise<Response | null>;
let HTTPError: new (...args: never[]) => { status: number; code: string };
let sha256: (value: string) => Promise<string>;

const fakeFlux = {
  // The router's other calls the mint path now makes (cap sync, status): answered as an agreeing router would.
  async setCap() {},
  async stop() {},
  async revokeKey() {},
  async status() { return { state: "ok" }; },
  async mint(input: { generation: number; ttlSeconds: number; capMicrocents: number; homeId: string }) {
    minted.push({ generation: input.generation });
    return { key: `sk-flux-home-${"k".repeat(24)}-g${input.generation}`, expiresAt: new Date(controlNow + input.ttlSeconds * 1000).toISOString(), generation: input.generation, capMicrocents: input.capMicrocents };
  },
};
const row = () => db.prepare("SELECT * FROM flux_home_keys WHERE home_id=?").get(HOME) as Record<string, unknown>;

beforeAll(async () => {
  ({ fluxRoute } = await import(join(cpSource, "b4-flux.ts")));
  ({ HTTPError } = await import(join(cpSource, "http.ts")));
  ({ sha256 } = await import(join(cpSource, "installations.ts")));
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", async () => {
      if (req.url?.endsWith("/flux/subkey/ack")) acks += 1;
      const env = { DB: d1(db), FLUX_CLOUD_SERVICE_TOKEN: "s".repeat(40), FLUX_CLOUD_GRANTS_TOKEN: "g".repeat(40), CLOUD_FLUX_ROUTES_ENABLED: "1", FLUX_API_BASE: "https://api.fluxrouter.ai" };
      const request = new Request(`https://cp.test${req.url}`, { method: req.method, body: req.method === "GET" ? undefined : Buffer.concat(chunks),
        headers: { authorization: req.headers.authorization ?? "", "content-type": "application/json", "CF-Connecting-IP": IP } });
      let response: Response;
      try {
        response = (await fluxRoute(request, env as never, {} as never, { now: () => controlNow, fluxClient: () => fakeFlux, billingFlux: { stub: false, capabilities: { reversalTargets: true } }, ownerOf: async () => OWNER } as never)) ?? new Response("{}", { status: 404 });
      } catch (error) {
        response = error instanceof HTTPError ? new Response(JSON.stringify({ error: error.code }), { status: error.status }) : new Response("{}", { status: 500 });
      }
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(() => { server?.close(); });

beforeEach(async () => {
  controlNow = NOW;
  db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) db.exec(readFileSync(join(migrations, name), "utf8"));
  db.prepare("INSERT INTO cloud_machines (id,home_id,generation,state,credential_hash,bound_ips,created_at,public_origin,admin_url) VALUES (?,?,1,'active',?,?,?,?,?)")
    .run(HOME, HOME, await sha256(TOKEN), JSON.stringify([IP]), NOW, "https://h.murage.test", "https://admin.murage.test");
  db.prepare("INSERT INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced) VALUES (?,?,?,?,1,0)").run(OWNER, "flux-account-1", NOW, "link-1");
  db.prepare(`INSERT INTO flux_home_keys (home_id,plan,generation,state,cap_microcents,cap_custom,lifecycle_version,key_expires_at,updated_at,cap_version,gen_floor,link_id,link_version)
    VALUES (?,?,1,'active',30000000,0,1,?,?,1,1,'link-1',1)`).run(HOME, "starter", NOW + 3 * DAY, NOW);
  minted = []; acks = 0;
});

const driver = `import importlib.machinery,importlib.util,json,os,sys,time
l=importlib.machinery.SourceFileLoader("poller_e2e",sys.argv[1]);spec=importlib.util.spec_from_loader(l.name,l);m=importlib.util.module_from_spec(spec);l.exec_module(m)
binding={"homeId":sys.argv[3],"generation":1,"adminUrl":"http://127.0.0.1:"+sys.argv[2],"publicOrigin":"https://h.murage.test","credential":sys.argv[4]}
root=sys.argv[5];directory=root+"/flux-subkey";pending=root+"/state/flux-ack-pending.json";mode=sys.argv[6];offset=float(sys.argv[7]);uid=os.getuid();gid=os.getgid()
real_ack=m.ack_flux_subkey;drop=[mode=="drop-ack"]
def ack(b,r,p):
    if drop[0]:
        drop[0]=False
        raise OSError("ack lost")
    return real_ack(b,r,p)
try:
    m.renew_flux_subkey(binding,{"fluxRenewalDue":True},m.machine_request,lambda b,r,op: m.deliver_flux_subkey(b,r,op,directory,uid,gid),ack,pending_path=pending,directory=directory,owner_uid=uid,owner_gid=gid,expected_uid=uid,wall=lambda: time.time()+offset)
    print(json.dumps("ok"))
except Exception as e:
    print(json.dumps("error:"+type(e).__name__))`;

let root = "";
beforeEach(() => { root = mkdtempSync(join(process.cwd(), ".renewal-e2e-")); chmodSync(root, 0o755); mkdirSync(join(root, "state"), { mode: 0o700 }); });
afterEach(() => { removeTempDirSync(root); });
const handoffDir = () => join(root, "flux-subkey");
const pendingFile = () => join(root, "state", "flux-ack-pending.json");

/** One poller process (a fresh process each time is also a poller restart: only the on-disk state survives). Async on purpose: the control-plane shim lives in THIS process. */
async function poll(mode = "normal", offsetSeconds = 0) {
  controlNow = NOW + offsetSeconds * 1000; // The control plane and poller share elapsed time, including the unacked-key retry bound.
  const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn("python3", ["-I", "-c", driver, program, String(port), HOME, TOKEN, root, mode, String(offsetSeconds)]);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as string;
}
const handoff = () => { const file = join(handoffDir(), "key.json"); return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : null; };
/** The supervisor's side, with the real TypeScript: read the hand-off, (seal), write the receipt and remove the hand-off. */
const supervisorSeals = () => { const delivery = peekFluxSubkey(handoffDir(), process.getuid!()); expect(delivery).not.toBeNull(); completeFluxSubkey(delivery!, handoffDir(), process.getuid!()); };

describe("hole 11 / finding 8: renewal, end to end (real poller code against the real control-plane handler)", () => {
  it("finding 8: a due renewal hands the key over but sends NO ack until the supervisor's receipt exists", async () => {
    const before = row().key_expires_at as number;
    expect(await poll()).toBe("ok");
    expect(minted).toHaveLength(1);
    const delivered = handoff()!;
    expect(delivered).toMatchObject({ generation: 2, capUsd: 30 });
    expect(Object.keys(delivered).sort()).toEqual(["capUsd", "expiresAt", "generation", "key", "op_id"]);
    expect(String(delivered.key)).toMatch(/^sk-flux-home-/);
    // No supervisor seal: any number of polls send no ack, mint nothing more, and the control plane still says renewal is due.
    expect(await poll()).toBe("ok"); expect(await poll()).toBe("ok");
    expect(acks).toBe(0); expect(minted).toHaveLength(1);
    expect(row().key_expires_at).toBe(before);
    expect(row().pending_op_id).not.toBeNull();
    // The pending record carries identifiers only, never key material.
    expect(readFileSync(pendingFile(), "utf8")).not.toMatch(/sk-flux|"key"/);
    expect(JSON.parse(readFileSync(pendingFile(), "utf8"))).toMatchObject({ op_id: delivered.op_id, generation: 1, key_generation: 2 });
    // The supervisor seals and writes the receipt: the next poll acks, exactly once, and clears everything.
    supervisorSeals();
    expect(existsSync(join(handoffDir(), "receipt.json"))).toBe(true);
    expect(readFileSync(join(handoffDir(), "receipt.json"), "utf8")).not.toMatch(/sk-flux/);
    expect(await poll()).toBe("ok");
    expect(acks).toBe(1);
    expect(row().key_expires_at).toBe(Date.parse(String(delivered.expiresAt)));
    expect(row().pending_op_id).toBeNull();
    expect(existsSync(pendingFile())).toBe(false); expect(existsSync(join(handoffDir(), "receipt.json"))).toBe(false); expect(handoff()).toBeNull();
    expect(await poll()).toBe("ok"); // not due any more
    expect(minted).toHaveLength(1); expect(acks).toBe(1);
  });
  it("finding 8: a poller restart with a pending record resumes and acks once, without minting again", async () => {
    await poll();                       // hand-off written, pending persisted, then this process exits
    supervisorSeals();
    expect(await poll()).toBe("ok");    // a brand new process finds the pending record and the receipt
    expect(acks).toBe(1); expect(minted).toHaveLength(1);
    expect(row().pending_op_id).toBeNull();
    await poll(); expect(acks).toBe(1);
  });
  it("finding 8: a lost ack response is retried from the pending record and receipt; no second key is minted", async () => {
    await poll(); supervisorSeals();
    const before = row().key_expires_at as number;
    expect(await poll("drop-ack")).toBe("error:OSError");
    expect(row().key_expires_at).toBe(before);
    expect(existsSync(pendingFile())).toBe(true); expect(existsSync(join(handoffDir(), "receipt.json"))).toBe(true);
    expect(await poll()).toBe("ok");
    expect(minted).toHaveLength(1); expect(row().pending_op_id).toBeNull();
    expect(row().key_expires_at as number).toBeGreaterThan(NOW + 7 * DAY);
  });
  it("finding 8: a hand-off the supervisor never seals is dropped after the window and renewal proceeds", async () => {
    await poll();
    expect(await poll("normal", 1000)).toBe("ok"); expect(minted).toHaveLength(1); // inside the 30 minute window: still waiting
    expect(await poll("normal", 1900)).toBe("ok");                                  // past it: pending dropped, a new key is requested
    expect(minted.map(item => item.generation)).toEqual([2, 3]);
    expect(handoff()).toMatchObject({ generation: 3 }); expect(acks).toBe(0);
  });
});

// R8e: the owner's Stop through the real S1 route (POST /api/bots/:id/interrupt, readBody awaited) against the synchronous writer transaction that
// refuses the turn, in a spawned production server. The transaction is held at an explicit synchronous injection point (a seam route added to the
// child's index.ts source, inside the real database transaction, released by a file the test writes), so no delay decides the order. A raw HTTP
// request is handed to the kernel while the child's event loop is blocked in the transaction; it can only run after COMMIT.
// The seam calls the real admitted lease's onLedgerRefused (the same call index.ts:16263 makes) inside the real transaction().
import { request } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { LEDGER_REFUSAL_LINE } from "./ledger-refusal.ts";

const LATE = "[turn] late-cause=owner-stop after=ledger";
let fixture: VerificationServer, headers: Record<string, string>;
const file = (name: string) => join(fixture.info.dataDir, `r8e-${name}`);
let from = 0;
const log = () => readFileSync(fixture.info.logPath, "utf8").split("\n").slice(from);
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
/** Resolves with `sent` once the request bytes are written to the socket (handed to the kernel), and `done` with the response. */
function rawPost(path: string, body: unknown) {
  const url = new URL(fixture.info.url);
  let sent!: () => void;
  const written = new Promise<void>(resolve => { sent = resolve; });
  const done = new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path, method: "POST", headers: { ...headers, "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : undefined }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body), () => sent());
  });
  return { written, done };
}
const texts = async (threadId: string) => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[]).map(m => String(m.text ?? ""));

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');const { registerHooks } = await import('node:module');
      const at=name=>path.join(process.env.MURAGE_DATA_DIR,'r8e-'+name);
      globalThis[Symbol.for('r8e.hold')] = (transaction, lease) => {
        try { transaction(() => {
          lease.onLedgerRefused({ state: 'checking', reason: 'not-built' });
          fs.writeFileSync(at('held'), '');
          const wait = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(at('release'))) Atomics.wait(wait, 0, 0, 5); // the order is pinned by the file, not by the delay
        }); } catch (error) { console.warn('[r8e] seam threw ' + (error && error.stack)); throw error; }
        console.warn('[r8e] committed');
      };
      // Mutant R8E_MUTANT=inside: the transaction stays open across an await, so the Stop route runs before COMMIT. The seam commits only once the
      // Stop's late cause is logged and the release file exists, which pins the interleaving the real synchronous transaction cannot have.
      if (${JSON.stringify(process.env.R8E_MUTANT ?? "")} === 'inside') globalThis[Symbol.for('r8e.hold')] = (transaction, lease) => {
        lease.onLedgerRefused({ state: 'checking', reason: 'not-built' });
        fs.writeFileSync(at('held'), '');
        const warn = console.warn.bind(console); let stopped; const seen = new Promise(resolve => { stopped = resolve; });
        console.warn = (...args) => { if (String(args[0]).includes('late-cause=owner-stop')) stopped(); return warn(...args); };
        void (async () => { await seen; while (!fs.existsSync(at('release'))) await new Promise(resolve => setTimeout(resolve, 5)); transaction(() => {}); console.warn('[r8e] committed'); })();
      };
      registerHooks({ load(url, context, next) {
        const result = next(url, context);
        // Mutant R8E_MUTANT=late: a cause noted after the freeze is dropped without its late-cause line.
        if (${JSON.stringify(process.env.R8E_MUTANT ?? "")} === 'late' && url === ${JSON.stringify(new URL("./turn-end.ts", import.meta.url).href)}) {
          const line = ${JSON.stringify("if (frozen) { console.warn(`[turn] late-cause=${cause} after=${frozen.kind}`); return false; }")};
          if (!String(result.source).includes(line)) throw new Error('r8e late mutant missing');
          return { ...result, source: String(result.source).replace(line, 'if (frozen) return false;') };
        }
        if (url !== ${JSON.stringify(new URL("./index.ts", import.meta.url).href)}) return result;
        let source = String(result.source);
        const route = 'await gateWriteRequest(method);';
        if (!source.includes(route)) throw new Error('r8e seam missing');
        source = source.replace(route, route + " if (path === '/api/internal/r8e-hold') { try { const t = new URL(req.url, 'http://x').searchParams.get('t'); const lease = admittedLedgerLeases.get(directRuns.get(t).generation); globalThis[Symbol.for('r8e.hold')](transaction, lease); return json(res, 200, { ok: true }); } catch (error) { return json(res, 500, { seam: String(error && error.stack).slice(0, 400) }); } }");
        return { ...result, source };
      }});
  ` });
  const proof = await fetch(`${fixture.info.url}/api/desktop-secret`).then(response => response.json() as Promise<any>);
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60_000);
afterAll(async () => { await fixture?.close(); });

async function heldTurn() {
  const model = (await api("GET", "/api/instances")).body.instances.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
  const bot = (await api("POST", "/api/bots", { name: "R8e fixture", modelSelection: { instanceId: "verification", model } })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false })).status).toBe(200);
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "r8e hold __fixture_hold_authority__" })).status).toBe(202);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id)?.busy, { timeout: 30_000 }).toBe(true);
  return bot as { id: string; threadId: string };
}

it.skipIf(process.platform === "win32")("DURING: a Stop sent through S1 while the writer transaction is held runs after COMMIT, never inside; the owner reads the ledger sentence once", async () => {
  const bot = await heldTurn();
  from = readFileSync(fixture.info.logPath, "utf8").split("\n").length;
  const seam = fetch(`${fixture.info.url}/api/internal/r8e-hold?t=${bot.threadId}`, { headers });
  await expect.poll(() => existsSync(file("held")), { timeout: 20_000 }).toBe(true)
  // The child's loop is blocked inside the transaction: the Stop is handed to the kernel now and cannot be served.
  const stop = rawPost(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  await stop.written;
  expect(log().filter(line => line.includes(LATE))).toEqual([]); // nothing of the Stop ran inside the transaction
  expect(log().some(line => line.includes("[r8e] committed"))).toBe(false);
  writeFileSync(file("release"), "");
  expect((await seam).status).toBe(200);
  const stopped = await stop.done;
  expect(stopped.status).toBe(200);
  const lines = log();
  const committed = lines.findIndex(line => line.includes("[r8e] committed")), late = lines.filter(line => line.includes(LATE));
  expect(committed).toBeGreaterThan(-1);
  expect(late).toHaveLength(1);
  expect(lines.findIndex(line => line.includes(LATE))).toBeGreaterThan(committed); // applied after the commit
  await expect.poll(async () => (await texts(bot.threadId)).filter(text => text === LEDGER_REFUSAL_LINE).length, { timeout: 20_000 }).toBe(1);
  expect((await texts(bot.threadId)).filter(text => text === LEDGER_REFUSAL_LINE)).toHaveLength(1);
}, 120_000);

it.skipIf(process.platform === "win32")("AFTER: a Stop sent through S1 once the transaction committed is applied after it: the ledger sentence stands once, Stop is a late cause", async () => {
  const bot = await heldTurn();
  from = readFileSync(fixture.info.logPath, "utf8").split("\n").length;
  writeFileSync(file("release"), ""); // the gate is already open, so the transaction commits at once
  expect((await fetch(`${fixture.info.url}/api/internal/r8e-hold?t=${bot.threadId}`, { headers })).status).toBe(200);
  expect(log().some(line => line.includes("[r8e] committed"))).toBe(true);
  expect(log().filter(line => line.includes(LATE))).toEqual([]);
  expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
  const lines = log();
  expect(lines.filter(line => line.includes(LATE))).toHaveLength(1);
  expect(lines.findIndex(line => line.includes(LATE))).toBeGreaterThan(lines.findIndex(line => line.includes("[r8e] committed")));
  await expect.poll(async () => (await texts(bot.threadId)).filter(text => text === LEDGER_REFUSAL_LINE).length, { timeout: 20_000 }).toBe(1);
}, 120_000);

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createOpenAIChatRuntime } from "./drivers/openai-chat.ts";
import { recordEvents } from "./testing/events.ts";
import { fixtureBotFolder } from "./testing/bot-folder-fixture.ts";
const fixtureApi = existsSync(new URL("./testing/consuming-fixture.ts", import.meta.url)) ? await import("./testing/consuming-fixture.ts") : undefined;
const consumingFixture: typeof import("./testing/consuming-fixture.ts").consumingFixture = (...args) => {
  expect(fixtureApi?.consumingFixture, "the consuming fixture boundary must exist before retained delivery").toBeTypeOf("function");
  return fixtureApi!.consumingFixture(...args);
};
const responseApi = existsSync(new URL("./consuming-turn-response.ts", import.meta.url)) ? await import("./consuming-turn-response.ts") : undefined;
const emitConsumingTurnResponse: typeof import("./consuming-turn-response.ts").emitConsumingTurnResponse = (...args) => {
  expect(responseApi?.emitConsumingTurnResponse, "the consuming response boundary must exist before release").toBeTypeOf("function");
  return responseApi!.emitConsumingTurnResponse(...args);
};
const registerConsumingDescriptor: typeof import("./consuming-turn-response.ts").registerConsumingDescriptor = (...args) => {
  expect(responseApi?.registerConsumingDescriptor, "the consuming descriptor boundary must exist before registration").toBeTypeOf("function");
  return responseApi!.registerConsumingDescriptor(...args);
};
import { isDatabaseBusy, DEFAULT_BUSY_MS } from "./db-busy.ts";
import { handleModelGateway } from "./model-gateway.ts";
const gatewayReleaseApi = existsSync(new URL("./model-gateway-release.ts", import.meta.url)) ? await import("./model-gateway-release.ts") : undefined;
const issueGatewayTurnCredential: typeof import("./model-gateway-release.ts").issueGatewayTurnCredential = (...args) => {
  expect(gatewayReleaseApi?.issueGatewayTurnCredential, "the gateway admission boundary must exist before inference").toBeTypeOf("function");
  return gatewayReleaseApi!.issueGatewayTurnCredential(...args);
};
const revokeGatewayTurnCredentials: typeof import("./model-gateway-release.ts").revokeGatewayTurnCredentials = (...args) => {
  expect(gatewayReleaseApi?.revokeGatewayTurnCredentials).toBeTypeOf("function");
  return gatewayReleaseApi!.revokeGatewayTurnCredentials(...args);
};
const extractorApi = existsSync(new URL("./testing/source-extract.ts", import.meta.url)) ? await import("./testing/source-extract.ts") : undefined;
import { ModelSignIns } from "./model-signin.ts";
import { saveContinuationRecord, readContinuationRecord } from "./decision/records.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function latePeer() {
  let bytes = 0;
  const server = createServer(async (req, res) => { for await (const chunk of req) bytes += chunk.length; res.end('{}'); });
  const url = await listen(server);
  const f = consumingFixture(); cleanups.push(() => f.close());
  const actualFetch = globalThis.fetch;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const lateFetch: typeof fetch = (_url, init) => {
    // This is a real loopback socket write. Revoke after fetch has queued its
    // connection, while the connector callback has not returned a socket yet.
    const pending = actualFetch(url, init);
    queueMicrotask(() => { f.flip(); entered(); }); return pending;
  };
  return { f, url, lateFetch, started, bytes: () => bytes };
}
it("A-F1a HTTP late revoke openai-chat releases zero request-body bytes", async () => {
  const p = await latePeer(); vi.stubGlobal("fetch", p.lateFetch);
  const runtime = createOpenAIChatRuntime({
    input: { instanceId: "late-provider", displayName: "Fixture", environment: {}, enabled: true, config: {} },
    driverKind: "late-provider", apiKey: "fixture", apiUrl: p.url, tools: false,
    models: () => ({ default: "fixture", options: [{ id: "fixture", label: "Fixture" }] }),
    requestBody: (model, messages, stream) => ({ model, messages, stream }),
    httpErrorLabel: "Fixture", missingKeyError: "missing", unavailableReason: "missing", timeoutMs: 1000,
    nativeLog: { source: "fixture", outgoing: (_turn, messages, model) => ({ model, messages }), incoming: ({ text, usage }) => ({ text, usage }) },
  });
  cleanups.push(() => runtime.dispose());
  const events = recordEvents(runtime.adapter); cleanups.push(() => events.stop());
  await runtime.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "T", text: "private fixture prompt", releaseBinding: p.f.binding });
  await p.started;
  await events.until(event => event.type === "turn.completed");
  expect(p.bytes()).toBe(0);
  expect(p.f.refusals).toBe(1);
  expect(() => emitConsumingTurnResponse(p.f.binding, registerConsumingDescriptor("gateway:upstream-request", "request"), { bytes: 1, refs: [], write: () => {} })).toThrow("MEMORY_CONTEXT_REVOKED");
});
it("A-F1b HTTP late revoke model-gateway releases zero request-body bytes", async () => {
  const p = await latePeer();
  const signIns = new ModelSignIns({ env: {} });
  signIns.apply({ type: "murage:model-signin", entries: [{ provider: "chatgpt", connectionId: "signin-chatgpt", revision: "fixture", state: "connected", accessToken: "fixture", expiresAt: Date.now() + 3600000 }] });
  const key = issueGatewayTurnCredential("signin-chatgpt", p.f.binding);
  cleanups.push(() => revokeGatewayTurnCredentials(p.f.binding.identity.dispatchGeneration));
  const gateway = createServer((req, res) => { void handleModelGateway(req, res, req.url!, { signIns, catalog: () => ({ models: [] }) as never, fetch: p.lateFetch }); });
  const url = await listen(gateway);
  const result = await fetch(`${url}/api/model-gateway/signin-chatgpt/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "fixture", input: "private fixture prompt", stream: false }) });
  expect(result.status).toBe(409);
  expect(await result.text()).toBe("I stopped this turn because some of its context is no longer available.");
  expect(p.bytes()).toBe(0);
  expect(p.f.refusals).toBe(1);
});

it("A3-3 revalidates final ownership immediately before accepted write", () => {
  const f = consumingFixture(); cleanups.push(() => f.close());
  const write = vi.fn(); let checks = 0;
  // The ownership oracle changes after the entry and initial writer checks.
  // The final acceptance must ask it again, including a response with no refs.
  const binding = { ...f.binding, isCurrent: () => ++checks < 3 };
  expect(() => emitConsumingTurnResponse(binding, registerConsumingDescriptor("gateway:json-error-limit-done", "body"), { bytes: 1, refs: [], write })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(checks).toBe(3);
  expect(write).not.toHaveBeenCalled();
});

function releaseFixture(revoked: boolean) {
  const f = consumingFixture(); cleanups.push(() => f.close());
  const other = new DatabaseSync(String(f.f.db.prepare("PRAGMA database_list").get()!.file));
  cleanups.push(() => { try { if (other.isTransaction) other.exec("ROLLBACK"); } finally { other.close(); } });
  if (revoked) f.flip();
  // BEGIN is the acquire handshake: return means the second connection owns
  // the WAL writer; no timer estimates whether the lock exists.
  other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  const write = vi.fn();
  const release = () => emitConsumingTurnResponse(f.binding, registerConsumingDescriptor("gateway:json-error-limit-done", "body"), { bytes: 1, refs: [], write });
  return { f, other, write, release };
}
it("A-F2a contention is not revoke", () => {
  const { f, other, write, release } = releaseFixture(false);
  const started = performance.now(); let error: unknown;
  try { release(); } catch (caught) { error = caught; }
  expect(performance.now() - started).toBeLessThan(750);
  expect(isDatabaseBusy(error)).toBe(true);
  expect(f.refusals).toBe(0);
  expect(f.f.db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(DEFAULT_BUSY_MS);
  other.exec("ROLLBACK"); release();
  expect(write).toHaveBeenCalledOnce();
  expect(f.refusals).toBe(0);
});
it("A-F2b contention with revoked binding refuses exactly once", () => {
  const { f, other, write, release } = releaseFixture(true);
  expect(release).toThrow("MEMORY_CONTEXT_REVOKED");
  other.exec("ROLLBACK");
  expect(release).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.refusals).toBe(1);
  expect(write).not.toHaveBeenCalled();
});
it("A-F2c continuation persistence preserves competing first writer and caller timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "safety-continuation-"));
  const db = new DatabaseSync(join(dir, "fixture.db")), other = new DatabaseSync(join(dir, "fixture.db"));
  cleanups.push(async () => { try { if (other.isTransaction) other.exec("ROLLBACK"); } finally { other.close(); db.close(); await removeTempDir(dir); } });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10; CREATE TABLE decision_continuations(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const prepare = db.prepare.bind(db); let raced = false;
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (!raced && sql.startsWith("INSERT INTO decision_continuations")) { raced = true; other.prepare("INSERT INTO decision_continuations VALUES(?,?)").run("fixture", "first"); }
    return prepare(sql);
  });
  expect(() => saveContinuationRecord(db, "fixture", "second")).toThrow("continuation-conflict");
  expect(readContinuationRecord(db, "fixture")).toBe("first");
  other.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  expect(() => saveContinuationRecord(db, "fixture", "third")).toThrow("continuation-conflict");
  expect(performance.now() - started).toBeLessThan(60);
  expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(10);
});
it("FL-1 contention fixture cleanup is deterministic", async () => {
  const file = new URL("./ledger-refusal-server.test.ts", import.meta.url);
  const text = readFileSync(file,"utf8"), source = ts.createSourceFile("ledger-refusal-server.test.ts",text,ts.ScriptTarget.Latest,true);
  let cleanupStatement = "";
  const visit = (node: ts.Node): void => {
    // MAIN RULING 1114-SC-SAFETY-HSCOPE4: the original lock case is frozen;
    // failed-BEGIN cleanup coverage lives in its additional, separately named case.
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith("SC-SAFETY added coverage: T-BUSY-RELEASE")) {
      const callback = node.arguments[1];
      if (callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body)) {
        const transaction = callback.body.statements.find(statement => ts.isTryStatement(statement) && statement.finallyBlock);
        if (transaction && ts.isTryStatement(transaction)) cleanupStatement = transaction.finallyBlock!.statements.find(statement => ts.isIfStatement(statement) && statement.expression.getText(source) === "lock")?.getText(source) ?? "";
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(source);
  expect(cleanupStatement.length).toBeGreaterThan(0);
  expect(extractorApi?.extractFunction, "the shared extractor must construct the actual contention cleanup").toBeTypeOf("function");
  const extracted = extractorApi!.extractFunction({file,text,select:()=>`(lock) => { ${cleanupStatement} }`});
  const {value:cleanup} = await extracted.preflight();
  // A failed BEGIN leaves an open connection without a transaction. Run the
  // actual shipped finally statement against that I/O-edge state, not a copy.
  const failedBegin = { isTransaction:false, exec:vi.fn(() => { throw new Error("cannot rollback - no transaction is active"); }), close:vi.fn() };
  expect(() => cleanup(failedBegin)).not.toThrow();
  expect(failedBegin.exec).not.toHaveBeenCalled();
  expect(failedBegin.close).toHaveBeenCalledOnce();
  for (let n = 0; n < 25; n++) {
    const dir = mkdtempSync(join(tmpdir(), "safety-lock-cleanup-"));
    const path = join(dir, "fixture.db");
    const first = new DatabaseSync(path), second = new DatabaseSync(path);
    try {
      first.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(n INTEGER)");
      second.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
      expect(second.isTransaction).toBe(true);
      second.exec("ROLLBACK");
      expect(second.isTransaction).toBe(false);
      first.exec("BEGIN IMMEDIATE; INSERT INTO fixture VALUES(1); COMMIT");
      expect(first.prepare("SELECT count(*) AS n FROM fixture").get()!.n).toBe(1);
    } finally { try { if (second.isTransaction) second.exec("ROLLBACK"); } finally { second.close(); first.close(); await removeTempDir(dir); } }
    expect(existsSync(dir)).toBe(false);
  }
});
it("A-F6 the two previously new Node regression IDs pass", () => {
  const patterns = [
    ["scripts/no-limits-live/qualification.node-test.mjs", "gate qualifier qualify-bindings-mutants.mjs kills every activated mutant"],
    ["scripts/no-limits-live/workflows.node-test.mjs", "every standalone workflow binding and field self-test must pass"],
  ];
  for (const [file, id] of patterns) {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", `--test-name-pattern=${id}`, file!], { encoding: "utf8", timeout: 300000, env, maxBuffer: 16 * 1024 * 1024 });
    expect(result.error, id).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout, id).toContain(id!);
  }
}, 610000);

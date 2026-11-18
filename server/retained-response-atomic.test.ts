import { expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { consumingFixture, consumingResponseRecorder } from "./testing/consuming-fixture.ts";
import { fixtureContract } from "./memory/testing/writetime-fixture.ts";

const responseUrl = new URL("./consuming-turn-response.ts", import.meta.url);
const api = () => fixtureContract<typeof import("./consuming-turn-response.ts")>(responseUrl, "R1 retained response owns the actual synchronous enqueue");
const sentinel = Buffer.from("scopes7c retained response sentinel");

it("R1 HTTP native header failure is not replaced by a memory-denial write", async () => {
  const response = await api(), f = consumingFixture(), sink = consumingResponseRecorder();
  const failure = new Error("native header failure");
  const headers = vi.fn(() => { throw failure; });
  sink.raw.writeHead = headers as typeof sink.raw.writeHead;
  const writer = response.consumingHttpWriter(sink.raw, f.binding, {
    headers: response.registerConsumingDescriptor("gateway:headers", "headers"),
    body: response.registerConsumingDescriptor("gateway:json-error-limit-done", "body"),
    chunk: response.registerConsumingDescriptor("gateway:sse", "chunk"),
  });
  try {
    response.stageConsumingResponse(writer, []);
    let caught: unknown;
    try { writer.end("frame"); } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(headers).toHaveBeenCalledTimes(1);
    expect(f.refusals).toBe(0);
    expect(sink.destroyed).toBe(true);
    expect(f.budget.counts.attempts).toBe(1);
  } finally { f.close(); }
});

it.each(["before-entry", "at-enqueue", "after-enqueue"] as const)("R1 retained response/revoke %s", async order => {
  const response = await api(), f = consumingFixture();
  f.f.db.exec("PRAGMA journal_mode=WAL");
  const path = String(f.f.db.prepare("PRAGMA database_list").get()!.file);
  const competitor = new DatabaseSync(path); competitor.exec("PRAGMA busy_timeout=0");
  const revoke = () => competitor.exec("BEGIN IMMEDIATE; INSERT INTO memory_revoke_audience(revoke_id) VALUES(77); INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES('T',1,77,1,'fixture'); COMMIT");
  let frames = 0;
  const stream = new Writable({ write(bytes, _encoding, done) {
    expect(f.f.db.isTransaction, "actual stream enqueue remains under the installation writer lock").toBe(true);
    expect(bytes).toEqual(sentinel); frames++;
    if (order === "at-enqueue") expect(revoke).toThrow(/busy|locked/i);
    done();
  } });
  const descriptor = response.registerConsumingDescriptor("native:openai:tool-append", "native");
  const release = () => response.emitConsumingTurnResponse(f.binding, descriptor, { bytes: sentinel.length, refs: [], write: () => stream.write(sentinel) });
  try {
    const before = f.budget.counts.attempts;
    if (order === "before-entry") {
      revoke();
      expect(() => release()).toThrow("MEMORY_CONTEXT_REVOKED");
      expect(frames).toBe(0);
      expect(f.budget.counts.attempts).toBe(before);
      expect(f.refusals).toBe(1);
      return;
    }
    // The first accepted frame proves a functioning sink in every row. The
    // old X obligation is absent from the new frame's explicit refs.
    release(); expect(frames).toBe(1);
    expect(f.budget.counts.attempts - before).toBe(1);
    revoke();
    expect(() => release()).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(frames).toBe(1); expect(f.refusals).toBe(1);
  } finally { stream.destroy(); competitor.close(); f.close(); }
});

it("R1 a response cannot borrow another connection's retained authority", async () => {
  const response = await api(), f = consumingFixture(), write = vi.fn();
  f.f.db.exec("PRAGMA journal_mode=WAL");
  const other = new DatabaseSync(String(f.f.db.prepare("PRAGMA database_list").get()!.file));
  try {
    expect(() => response.emitConsumingTurnResponse(response.bindConsumingTurn({ ...f.binding, db: other }),
      response.registerConsumingDescriptor("native:openai:tool-append", "native"),
      { bytes: 1, refs: [], write })).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).not.toHaveBeenCalled();
  } finally { other.close(); f.close(); }
});

it("R1 a native writer failure keeps its identity and its one possible release charge", async () => {
  const response = await api(), f = consumingFixture();
  const failure = new Error("fixture native transport failure");
  try {
    const before = f.budget.counts.attempts;
    let caught: unknown;
    try { response.emitConsumingTurnResponse(f.binding,
      response.registerConsumingDescriptor("native:openai:tool-append", "native"),
      { bytes: 1, refs: [], write: () => { throw failure; } }); }
    catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(f.budget.counts.attempts - before).toBe(1);
    expect(f.refusals).toBe(0);
    expect(f.f.db.isTransaction).toBe(false);
  } finally { f.close(); }
});

it("R1 a caller's unrelated transaction cannot release or be rolled back by the response", async () => {
  const response = await api(), f = consumingFixture(), write = vi.fn();
  try {
    f.f.db.exec("BEGIN IMMEDIATE");
    expect(() => response.emitConsumingTurnResponse(f.binding, response.registerConsumingDescriptor("native:openai:tool-append", "native"), { bytes: 1, refs: [], write })).toThrow();
    expect(write).not.toHaveBeenCalled(); expect(f.f.db.isTransaction).toBe(true);
    f.f.db.exec("ROLLBACK");
  } finally { f.close(); }
});

it("R1 a commit failure after enqueue keeps one charge and seals the generation", async () => {
  const response = await api(), f = consumingFixture(), write = vi.fn();
  const original = f.f.db.exec.bind(f.f.db);
  const exec = vi.spyOn(f.f.db, "exec").mockImplementation(sql => { if (sql === "COMMIT") throw new Error("fixture commit failure"); return original(sql); });
  try {
    const before = f.budget.counts.attempts;
    expect(() => response.emitConsumingTurnResponse(f.binding, response.registerConsumingDescriptor("native:openai:tool-append", "native"), { bytes: 1, refs: [], write })).toThrow();
    expect(write).toHaveBeenCalledTimes(1); expect(f.budget.counts.attempts - before).toBe(1);
    expect(f.refusals).toBe(1);
  } finally { exec.mockRestore(); f.close(); }
});

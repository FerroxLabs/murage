import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { consumingBusyResponse, prepareConsumingHttp, stageConsumingResponse } from "./consuming-turn-response.ts";
import { addTurnParents } from "./memory/lineage-write.ts";
import { RELEASE_LIMITS } from "./memory/release-budget.ts";
import { sendDelegated } from "./route-delegation.ts";
import { afterCommit, onRollback } from "./tx-scope.ts";
import { consumingFixture, fixtureHttp } from "./testing/consuming-fixture.ts";

const fixtures: ReturnType<typeof consumingFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach(f => f.close()); });
function fixture() {
  const f = consumingFixture(); fixtures.push(f);
  f.f.db.exec("CREATE TABLE prepared_http(value TEXT)");
  return { ...f, http: fixtureHttp(f.binding, "POST /api/internal/resolve-image-reference") };
}
const rows = (f: ReturnType<typeof fixture>) => f.f.db.prepare("SELECT * FROM prepared_http").all();

it("prepares, serializes and accepts exactly once under the same writer lock", () => {
  const f = fixture(), order: string[] = [];
  const path = f.f.db.prepare("PRAGMA database_list").all()[0]!.file as string;
  const other = new DatabaseSync(path); other.exec("PRAGMA busy_timeout=0");
  const compete = () => other.exec("INSERT INTO prepared_http VALUES('competitor')");
  const end = f.http.raw.end.bind(f.http.raw);
  vi.spyOn(f.http.raw, "end").mockImplementation((...args: Parameters<typeof end>) => {
    expect(f.f.db.isTransaction).toBe(true);
    expect(compete).toThrow(/locked|busy/i);
    order.push("accepted");
    return end(...args);
  });
  try {
    sendDelegated(f.http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => {
      expect(f.f.db.isTransaction).toBe(true);
      expect(compete).toThrow(/locked|busy/i);
      f.f.db.exec("INSERT INTO prepared_http VALUES('prepared')");
      afterCommit(() => order.push("committed"));
      order.push("prepared");
      return { toJSON: () => { expect(f.f.db.isTransaction).toBe(true); order.push("serialized"); return { image: "fixture-image" }; } };
    } });
    expect(order).toEqual(["prepared", "serialized", "accepted", "committed"]);
    expect(f.http.output).toContainEqual({ status: 200, body: '{"image":"fixture-image"}' });
    expect(rows(f)).toEqual([{ value: "prepared" }]);
    expect(f.budget.counts.attempts).toBe(1);
    expect(f.budget.counts.bytes).toBe(Buffer.byteLength('{"image":"fixture-image"}'));
    expect(f.f.db.isTransaction).toBe(false);
    compete();
  } finally { other.close(); }
});

it.each(["replace", "revoke", "serialize"])("rolls back preparation and its hooks on %s before acceptance", failure => {
  const f = fixture(), rollback = vi.fn(), committed = vi.fn();
  expect(() => sendDelegated(f.http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => {
    f.f.db.exec("INSERT INTO prepared_http VALUES('prepared')");
    onRollback(rollback); afterCommit(committed);
    if (failure === "replace") f.replace();
    if (failure === "revoke") f.flip();
    return { toJSON: () => { if (failure === "serialize") throw new Error("fixture serialization failure"); return { image: "fixture-image" }; } };
  } })).toThrow(failure === "serialize" ? "fixture serialization failure" : "MEMORY_CONTEXT_REVOKED");
  expect(rows(f)).toEqual([]);
  expect(rollback).toHaveBeenCalledOnce(); expect(committed).not.toHaveBeenCalled();
  expect(f.http.output.some(row => row.status === 200)).toBe(false);
  expect(f.budget.counts.attempts).toBe(0);
  expect(f.f.db.isTransaction).toBe(false);
});

it("rolls back failed preparation before sending the declared error response", () => {
  const f = fixture(), rollback = vi.fn();
  sendDelegated(f.http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => {
    f.f.db.exec("INSERT INTO prepared_http VALUES('prepared')"); onRollback(rollback);
    throw new Error("fixture storage failure");
  }, preparationError: error => {
    expect((error as Error).message).toBe("fixture storage failure");
    expect(rows(f)).toEqual([]); expect(rollback).toHaveBeenCalledOnce();
    return { status: 507, provenance: { refs: [] }, body: { error: "storage unavailable" } };
  } });
  expect(f.http.output).toContainEqual({ status: 507, body: '{"error":"storage unavailable"}' });
  expect(f.budget.counts.attempts).toBe(1);
});

it.each(["throw", "commit"])("does not roll back or resend possibly accepted bytes after %s failure", failure => {
  const f = fixture(), rollback = vi.fn(), fallback = vi.fn();
  const end = f.http.raw.end.bind(f.http.raw), exec = f.f.db.exec.bind(f.f.db);
  if (failure === "throw") vi.spyOn(f.http.raw, "end").mockImplementation((...args: Parameters<typeof end>) => {
    end(...args); throw new Error("fixture transport failure");
  });
  else vi.spyOn(f.f.db, "exec").mockImplementation(sql => { if (sql === "COMMIT") throw new Error("fixture commit failure"); return exec(sql); });
  expect(() => sendDelegated(f.http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => {
    f.f.db.exec("INSERT INTO prepared_http VALUES('prepared')"); onRollback(rollback);
    return { image: "fixture-image" };
  }, preparationError: fallback })).toThrow(failure === "throw" ? "fixture transport failure" : "RELEASE_COMMIT_FAILED");
  expect(f.http.output.filter(row => row.body !== undefined)).toHaveLength(1);
  expect(f.budget.counts.attempts).toBe(1); expect(fallback).not.toHaveBeenCalled();
  expect(f.http.raw.destroyed).toBe(true); expect(f.f.db.isTransaction).toBe(false);
  if (failure === "throw") { expect(rows(f)).toEqual([{ value: "prepared" }]); expect(rollback).not.toHaveBeenCalled(); }
  else { expect(rows(f)).toEqual([]); expect(rollback).toHaveBeenCalledOnce(); }
});

it.each(["prepare", "accept", "thenable", "chunk", "twice", "missing", "nested", "busy"])("refuses invalid synchronous preparation: %s", failure => {
  const f = fixture(), prepared = vi.fn(() => ({ image: "fixture-image" }));
  const accept = () => {
    stageConsumingResponse(f.http.writer, []);
    if (failure === "nested") prepareConsumingHttp(f.http.writer, prepared, () => f.http.writer.end("nested"));
    if (failure === "busy") consumingBusyResponse(f.http.writer);
    if (failure === "chunk") f.http.writer.write("chunk");
    if (failure !== "missing") f.http.writer.end("prepared");
    if (failure === "twice") f.http.writer.end("second");
  };
  const prepare = failure === "prepare" ? async () => prepared() : failure === "thenable" ? () => Promise.resolve(prepared()) : prepared;
  expect(() => prepareConsumingHttp<unknown>(f.http.writer, prepare, failure === "accept" ? async () => accept() : accept)).toThrow("MEMORY_CONTEXT_REVOKED");
  if (failure === "prepare" || failure === "accept") expect(prepared).not.toHaveBeenCalled();
  expect(f.http.output.some(row => row.status === 200)).toBe(false);
  expect(f.budget.counts.attempts).toBe(0); expect(f.f.db.isTransaction).toBe(false);
});

it("validates parent additions made by preparation before committing them", () => {
  const f = fixture(), parents = f.turn.parents;
  f.f.audienceFlip("T", 2);
  expect(() => sendDelegated(f.http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => {
    f.f.db.exec("INSERT INTO prepared_http VALUES('prepared')");
    addTurnParents(f.turn, [{ kind: "line", threadId: "T", messageId: "Y" }]);
    return { image: "fixture-image" };
  } })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(rows(f)).toEqual([]); expect(f.turn.parents).toBe(parents);
  expect(f.http.output.some(row => row.status === 200)).toBe(false);
  expect(f.budget.counts.attempts).toBe(0);
});

it("checks the serialized body against the remaining byte budget before accepting it", () => {
  const f = fixture();
  f.budget.charge({ bytes: RELEASE_LIMITS.bytes - 2 });
  expect(() => sendDelegated(f.http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: () => {
    f.f.db.exec("INSERT INTO prepared_http VALUES('prepared')");
    return { image: "fixture-image" };
  } })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(rows(f)).toEqual([]); expect(f.budget.counts.attempts).toBe(0);
  expect(f.budget.counts.bytes).toBe(RELEASE_LIMITS.bytes - 2);
  expect(f.http.output.some(row => row.status === 200)).toBe(false);
});

it("does not invoke preparation after the turn's attempt budget is exhausted", () => {
  const f = fixture(), prepare = vi.fn(() => ({ image: "fixture-image" }));
  f.budget.charge({ attempts: RELEASE_LIMITS.attempts });
  expect(() => sendDelegated(f.http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: prepare })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(prepare).not.toHaveBeenCalled();
  expect(f.budget.counts.attempts).toBe(RELEASE_LIMITS.attempts);
  expect(f.http.output.some(row => row.status === 200)).toBe(false);
});

it("refuses an already revoked ledger before invoking preparation", () => {
  const f = fixture(), prepare = vi.fn(() => ({ image: "fixture-image" }));
  f.flip();
  expect(() => sendDelegated(f.http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: prepare })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(prepare).not.toHaveBeenCalled();
  expect(f.http.output.length).toBeGreaterThan(0);
  expect(f.http.output.every(row => row.status === 409)).toBe(true);
  expect(f.budget.counts.attempts).toBe(0);
});

it.each(["headers", "ended", "destroyed"])("never prepares a response whose transport is already %s", state => {
  const f = fixture(), prepare = vi.fn(() => ({ image: "fixture-image" }));
  if (state === "headers") f.http.raw.writeHead(200);
  if (state === "ended") f.http.raw.end();
  if (state === "destroyed") f.http.raw.destroy();
  const before = [...f.http.output];
  expect(() => sendDelegated(f.http.writer, "POST", { status: 200, provenance: { refs: [] }, prepareBody: prepare })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(prepare).not.toHaveBeenCalled();
  expect(f.http.output).toEqual(before);
  expect(f.budget.counts.attempts).toBe(0);
  if (state === "headers") expect(f.http.raw.destroyed).toBe(true);
});

it("does not join or roll back an unrelated transaction", () => {
  const f = fixture(), prepare = vi.fn();
  f.f.db.exec("BEGIN IMMEDIATE; INSERT INTO prepared_http VALUES('unrelated')");
  try {
    expect(() => prepareConsumingHttp(f.http.writer, prepare, () => f.http.writer.end("prepared"))).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(prepare).not.toHaveBeenCalled(); expect(f.f.db.isTransaction).toBe(true);
    expect(rows(f)).toEqual([{ value: "unrelated" }]);
    expect(f.http.output.some(row => row.status === 200)).toBe(false);
  } finally { f.f.db.exec("ROLLBACK"); }
});

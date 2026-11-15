import { expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { createConsumingIngress } from "./consuming-turn-ingress.ts";
import { registerConsumingDescriptor } from "./consuming-turn-response.ts";

function fixture() {
  const f = consumingFixture();
  const ingress = createConsumingIngress(f.binding, "atomic");
  ingress.request('{"jsonrpc":"2.0","id":1,"method":"ping"}', () => {});
  const frame = { instanceId: "atomic", sequence: 1, frame: '{"jsonrpc":"2.0","id":1,"result":{}}', refs: [],
    descriptor: registerConsumingDescriptor("test:proxy", "body") };
  return { f, ingress, frame };
}

it("R1 ingress permit preparation charges no emitted attempt or frame bytes", () => {
  const { f, ingress, frame } = fixture();
  try {
    const before = f.budget.counts;
    const envelope = ingress.issue(frame);
    expect(f.budget.counts.attempts).toBe(before.attempts);
    expect(f.budget.counts.bytes).toBe(before.bytes);
    const write = vi.fn();
    ingress.deliver(envelope, write);
    expect(write).toHaveBeenCalledExactlyOnceWith(frame.frame);
    expect(f.budget.counts.attempts - before.attempts).toBe(1);
    expect(f.budget.counts.bytes - before.bytes).toBe(Buffer.byteLength(frame.frame));
  } finally { ingress.retire(); f.close(); }
});

it.each(["request", "deliver", "accept"] as const)("R1 ingress %s preserves the native writer failure after one possible release", async path => {
  const { f, ingress, frame } = fixture(), failure = new Error("native destination failure");
  try {
    const envelope = ingress.issue(frame), before = f.budget.counts.attempts;
    let caught: unknown;
    const write = () => { throw failure; };
    try {
      if (path === "request") ingress.request('{"jsonrpc":"2.0","id":2,"method":"ping"}', write);
      else if (path === "deliver") ingress.deliver(envelope, write);
      else await ingress.accept(envelope, { capacity: async () => {}, write });
    } catch (error) { caught = error; }
    expect(caught).toBe(failure);
    expect(f.budget.counts.attempts - before).toBe(1);
    expect(ingress.sealed).toBe(true);
    expect(f.refusals).toBe(0);
    expect(f.f.db.isTransaction).toBe(false);
  } finally { ingress.retire(); f.close(); }
});

it("R1 ingress holds the installation writer lock at final destination acceptance", () => {
  const { f, ingress, frame } = fixture();
  f.f.db.exec("PRAGMA journal_mode=WAL");
  const other = new DatabaseSync(String(f.f.db.prepare("PRAGMA database_list").get()!.file));
  other.exec("PRAGMA busy_timeout=0");
  try {
    const envelope = ingress.issue(frame);
    ingress.deliver(envelope, value => {
      expect(value).toBe(frame.frame);
      expect(() => other.exec("BEGIN IMMEDIATE; COMMIT")).toThrow(/busy|locked/i);
    });
    expect(() => other.exec("BEGIN IMMEDIATE; COMMIT")).not.toThrow();
  } finally { other.close(); ingress.retire(); f.close(); }
});

import { mkdtempSync, readFileSync, rmSync, mkdirSync, rmdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelSendError, DurableDelivery } from "./durable-delivery.ts";
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-slack-ledger-")); roots.push(root);
  let now = 1000000000, current = true;
  const retained = new Map<string, { id: string }>();
  const enqueue = vi.fn(({ deliveryId }: { deliveryId: string; prompt: string }) => {
    const run = retained.get(deliveryId) ?? { id: "run-" + deliveryId }; retained.set(deliveryId, run); return run;
  });
  const result = vi.fn((_id: string): { status: string; output?: string } | null => ({ status: "completed", output: "Answer" }));
  const send = vi.fn(async (_input: { recipient: string; text: string; signal: AbortSignal }) => ({ recipient: "DOWNER", messageId: "1.2" }));
  const options = { file: join(root, "ledger.json"), bindingKey: "binding", recipient: "DOWNER", isCurrent: () => current, runs: { enqueue, result }, send, now: () => now };
  return { options, enqueue, result, send, retained, ledger: new DurableDelivery(options),
    input: { deliveryId: "event-1", prompt: "Request", occurredAt: now }, advance: (ms: number) => { now += ms; }, invalidate: () => { current = false; } };
}
it("durably admits once and preserves immutable input and recipient across retry/restart", async () => {
  const f = fixture(); f.ledger.accept(f.input);
  expect(JSON.parse(readFileSync(f.options.file, "utf8")).records[0].prompt).toBe("Request");
  const restarted = new DurableDelivery(f.options);
  expect(restarted.accept({ ...f.input, prompt: "Send somewhere else" })).toBe("duplicate");
  await Promise.all([restarted.drain(), restarted.drain()]);
  expect(f.enqueue).toHaveBeenCalledTimes(1); expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0][0]).toMatchObject({ recipient: "DOWNER", text: "Answer" });
  const disk = JSON.parse(readFileSync(f.options.file, "utf8")); expect(disk.records[0]).toMatchObject({ state: "sent", messageId: "1.2" });
  f.ledger.stop(); restarted.stop();
});
it("rolls back failed persistence; an intact retry can still accept", () => {
  const f = fixture(); mkdirSync(f.options.file);
  expect(() => f.ledger.accept(f.input)).toThrow(); expect(f.enqueue).not.toHaveBeenCalled();
  rmdirSync(f.options.file); expect(f.ledger.accept(f.input)).toBe("accepted");
});
it("reuses scheduler delivery identity after enqueue-before-ledger-save crash", async () => {
  const f = fixture(); f.ledger.accept(f.input); f.options.runs.enqueue(f.input);
  const restarted = new DurableDelivery(f.options); await restarted.drain();
  expect(f.retained.size).toBe(1); expect(f.send).toHaveBeenCalledTimes(1);
});
it("never reruns a missing queued receipt or a sending receipt on restart", async () => {
  const f = fixture(); f.result.mockReturnValue({ status: "running" }); f.ledger.accept(f.input); await f.ledger.drain();
  f.result.mockReturnValue(null); await new DurableDelivery(f.options).drain();
  expect(f.enqueue).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
  const disk = JSON.parse(readFileSync(f.options.file, "utf8")); expect(disk.records[0].state).toBe("needs-review");
  disk.records[0].state = "sending"; writeFileSync(f.options.file, JSON.stringify(disk));
  const restarted = new DurableDelivery(f.options); await restarted.drain();
  expect(restarted.status().uncertain).toBe(1); expect(f.send).not.toHaveBeenCalled();
});
it("only retries definite non-delivery after Retry-After, at most three attempts", async () => {
  const f = fixture(); f.send.mockRejectedValue(new ChannelSendError("rate-limit", false, 10)); f.ledger.accept(f.input);
  await f.ledger.drain(); await f.ledger.drain(); expect(f.send).toHaveBeenCalledTimes(1);
  f.advance(10000); await f.ledger.drain(); f.advance(10000); await f.ledger.drain(); f.advance(10000); await f.ledger.drain();
  expect(f.send).toHaveBeenCalledTimes(3); expect(f.ledger.status().rejected).toBe(1); expect(f.enqueue).toHaveBeenCalledTimes(1);
});
it.each([new ChannelSendError("timeout", true), new Error("arbitrary-secret-error")])("keeps ambiguous sends uncertain without replay", async error => {
  const f = fixture(); f.send.mockRejectedValue(error); f.ledger.accept(f.input);
  await f.ledger.drain(); await new DurableDelivery(f.options).drain();
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.ledger.status().uncertain).toBe(1);
  expect(readFileSync(f.options.file, "utf8")).not.toContain("arbitrary-secret-error");
});
it("rejects receipt recipient mismatch and fences revoked work", async () => {
  const f = fixture(); f.send.mockResolvedValue({ recipient: "DOTHER", messageId: "1.2" }); f.ledger.accept(f.input); await f.ledger.drain();
  expect(f.ledger.status().uncertain).toBe(1);
  f.invalidate(); expect(() => f.ledger.accept({ ...f.input, deliveryId: "another" })).toThrow();
  f.ledger.revoke(); await f.ledger.drain(); expect(f.send).toHaveBeenCalledTimes(1);
});
it("retains completed tombstones, bounds admission and rejects old replay", async () => {
  const f = fixture(); f.ledger.accept(f.input); await f.ledger.drain();
  f.ledger.accept({ ...f.input, deliveryId: "second" });
  expect(new DurableDelivery(f.options).accept(f.input)).toBe("duplicate");
  expect(JSON.parse(readFileSync(f.options.file, "utf8")).tombstones).toHaveLength(1);
  expect(() => f.ledger.accept({ ...f.input, deliveryId: "old", occurredAt: 0 })).toThrow();
  for (let i = 0; i < 199; i++) f.ledger.accept({ ...f.input, deliveryId: "pending-" + i });
  expect(() => f.ledger.accept({ ...f.input, deliveryId: "overflow" })).toThrow();
});
it("rejects linked state without touching the target", () => {
  const f = fixture(), target = join(roots.at(-1)!, "target"); writeFileSync(target, "keep"); symlinkSync(target, f.options.file);
  expect(() => new DurableDelivery(f.options)).toThrow(); expect(readFileSync(target, "utf8")).toBe("keep");
});

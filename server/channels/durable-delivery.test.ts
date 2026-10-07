import { mkdtempSync, readFileSync, rmSync, mkdirSync, rmdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as atomic from "../atomic.ts";
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
it("sends a run's voice notes after its text reply, and a note that fails does not unsend the reply", async () => {
  const f = fixture();
  const note = (name: string) => ({ name, mime: "audio/mpeg", bytes: new Uint8Array([1, 2]), text: "Hi", from: "Ember" });
  const voiceNotes = vi.fn((_id: string) => [note("a.mp3"), note("b.mp3")]);
  const sendAudio = vi.fn(async (input: { name: string }) => { if (input.name === "a.mp3") throw new ChannelSendError("forbidden", false); });
  const ledger = new DurableDelivery({ ...f.options, runs: { ...f.options.runs, voiceNotes }, sendAudio });
  ledger.accept(f.input); await ledger.drain();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(voiceNotes).toHaveBeenCalledWith("run-event-1");
  expect(sendAudio.mock.calls.map(call => call[0])).toEqual([
    expect.objectContaining({ recipient: "DOWNER", name: "a.mp3", mime: "audio/mpeg", title: "Voice note from Ember" }),
    expect.objectContaining({ name: "b.mp3" }),
  ]);
  expect(JSON.parse(readFileSync(f.options.file, "utf8")).records[0]).toMatchObject({ state: "sent" });
  ledger.stop();
});
it("keeps the 4000 character cap by default and lets an adapter raise it with maxResponse", async () => {
  const long = "x".repeat(9000);
  const f = fixture(); f.result.mockReturnValue({ status: "completed", output: long }); f.ledger.accept(f.input); await f.ledger.drain();
  expect(f.send.mock.calls[0][0].text).toHaveLength(4000);
  const g = fixture(); g.result.mockReturnValue({ status: "completed", output: long });
  const wide = new DurableDelivery({ ...g.options, maxResponse: 20000 }); wide.accept(g.input); await wide.drain();
  expect(g.send.mock.calls[0][0].text).toHaveLength(9000);
  expect(JSON.parse(readFileSync(g.options.file, "utf8")).records[0].response).toHaveLength(9000);
});
it("reserves ids before the send, passes them and the stored quote through, and treats a reserve failure as a send failure", async () => {
  const f = fixture();
  const reserve = vi.fn(async (_input: { recipient: string; text: string }) => ["wa-1", "wa-2"]);
  const ledger = new DurableDelivery({ ...f.options, reserve });
  ledger.accept({ ...f.input, quote: { id: "q1", remoteJid: "DOWNER", text: "hi" } }); await ledger.drain();
  expect(reserve).toHaveBeenCalledWith({ recipient: "DOWNER", text: "Answer" });
  expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ reserved: ["wa-1", "wa-2"], quote: { id: "q1", remoteJid: "DOWNER", text: "hi" } }));
  reserve.mockRejectedValueOnce(new ChannelSendError("offline", false));
  const g = fixture(); const failing = new DurableDelivery({ ...g.options, reserve });
  failing.accept(g.input); await failing.drain();
  expect(g.send).not.toHaveBeenCalled(); expect(JSON.parse(readFileSync(g.options.file, "utf8")).records[0]).toMatchObject({ state: "queued", error: "offline" });
});
it("marks a partial multi-chunk send uncertain with error partial and never retries it", async () => {
  const f = fixture(); f.send.mockRejectedValue(new ChannelSendError("unavailable", true, undefined, true)); f.ledger.accept(f.input);
  await f.ledger.drain(); await f.ledger.drain();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(f.options.file, "utf8")).records[0]).toMatchObject({ state: "uncertain", error: "partial" });
});
it("lists the run ids of unfinished records so an adapter can cancel one chat's tasks", async () => {
  const f = fixture(); f.result.mockReturnValue({ status: "running" }); f.ledger.accept(f.input); await f.ledger.drain();
  expect(f.ledger.pendingRunIds()).toEqual(["run-event-1"]);
});
it("hands a record's stored media to the run, reports what unfinished records still reference, and knows a delivery it already holds", async () => {
  const f = fixture();
  const media = [{ path: "/data/whatsapp/media/c/k/M1.jpg", mime: "image/jpeg", bytes: 10 }];
  f.ledger.accept({ ...f.input, media });
  expect(f.ledger.has("event-1")).toBe(true); expect(f.ledger.has("event-2")).toBe(false);
  expect(f.ledger.referencedMedia()).toEqual(["/data/whatsapp/media/c/k/M1.jpg"]);
  f.result.mockReturnValue({ status: "running" });
  await f.ledger.drain();
  expect(f.enqueue).toHaveBeenCalledWith({ deliveryId: "event-1", prompt: "Request", media });
  expect(f.ledger.referencedMedia()).toHaveLength(1);
  f.result.mockReturnValue({ status: "completed", output: "Answer" });
  await f.ledger.drain();
  expect(f.ledger.referencedMedia()).toEqual([]);
  expect(f.ledger.has("event-1")).toBe(true);
  f.ledger.stop();
});
it("sends no media field to a run when the record has none", async () => {
  const f = fixture(); f.ledger.accept(f.input); await f.ledger.drain();
  expect(f.enqueue).toHaveBeenCalledWith({ deliveryId: "event-1", prompt: "Request" });
  f.ledger.stop();
});

it.each([false, true])("erases an ephemeral response immediately when sending settles (failure=%s)", async failure => {
  const f = fixture();
  if (failure) f.send.mockRejectedValue(new ChannelSendError("forbidden", false));
  const ledger = new DurableDelivery({ ...f.options, clearResponseOnSettle: true });
  ledger.accept({ ...f.input, prompt: "", response: "pairing code ABC234" });
  await ledger.drain();
  const stored = readFileSync(f.options.file, "utf8");
  expect(stored).not.toContain("ABC234");
  expect(JSON.parse(stored).records[0].state).toBe(failure ? "rejected" : "sent");
  expect(f.enqueue).not.toHaveBeenCalled();
});

it("retains pairing responses across a retry and clears them on settlement", async () => {
  const f = fixture(), options = { ...f.options, clearResponseOnSettle: true };
  const ledger = new DurableDelivery(options);
  ledger.accept({ ...f.input, prompt: "", response: "Pairing code ABC234" });
  f.send.mockRejectedValueOnce(new ChannelSendError("offline", false));
  await ledger.drain();
  expect(JSON.parse(readFileSync(options.file, "utf8")).records[0]).toMatchObject({ state: "queued", response: "Pairing code ABC234" });
  ledger.stop(); f.advance(3000);
  const restarted = new DurableDelivery(options); await restarted.drain();
  expect(f.send).toHaveBeenCalledTimes(2); expect(f.enqueue).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(options.file, "utf8")).records[0]).toMatchObject({ state: "sent" });
  expect(readFileSync(options.file, "utf8")).not.toContain("ABC234"); restarted.stop();
});

it("migrates record and byte overflow atomically and drains retained receipts after restart", async () => {
  const f = fixture(), target = { ...f.options, maxResponse: 20000 }, source = { ...target, file: target.file + "-lid", recipient: "LID" };
  for (const [index, location] of [target, source].entries()) {
    writeFileSync(location.file, JSON.stringify({ version: 1, bindingKey: location.bindingKey, recipient: location.recipient,
      records: [...Array.from({ length: 105 }, (_, i) => ({ deliveryId: `${location.recipient}:${index}-${i}`, prompt: "p".repeat(5900),
        response: "r".repeat(20000), occurredAt: f.input.occurredAt, attempts: 0, state: i ? "needs-review" : "queued", runId: `retained-${index}-${i}` })),
        { deliveryId: `${location.recipient}:expired-record`, prompt: "", occurredAt: 0, attempts: 1, state: "sent" }],
      tombstones: [{ deliveryId: `${location.recipient}:expired`, occurredAt: 0 }],
    }));
  }
  const original = readFileSync(target.file, "utf8"), write = atomic.writeFileAtomic;
  const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, bytes, options) => {
    if (file === target.file) throw new Error("interrupted root write");
    return write(file, bytes, options);
  });
  const consolidate = () => DurableDelivery.consolidate(target, [source], id => id.replace(/^LID:/, "DOWNER:"), f.input.occurredAt);
  try { expect(consolidate).toThrow("interrupted root write"); } finally { spy.mockRestore(); }
  expect(readFileSync(target.file, "utf8")).toBe(original);
  expect(new DurableDelivery(target).status()).toMatchObject({ pending: 1, needsReview: 104 });
  consolidate();
  const root = readFileSync(target.file, "utf8");
  expect(JSON.parse(root).overflow.length).toBeGreaterThan(0);
  consolidate(); expect(readFileSync(target.file, "utf8")).toBe(root);
  const ledger = new DurableDelivery(target);
  expect(ledger.status()).toMatchObject({ pending: 2, needsReview: 208 });
  expect(ledger.pendingRunIds()).toEqual(["retained-1-0", "retained-0-0"]);
  await ledger.drain();
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledTimes(2);
  const restarted = new DurableDelivery(target);
  expect(restarted.status()).toMatchObject({ pending: 0, needsReview: 208 });
  expect(restarted.has("DOWNER:1-0")).toBe(true);
  expect(restarted.has("DOWNER:expired")).toBe(false);
  expect(restarted.has("DOWNER:expired-record")).toBe(false);
  await restarted.drain(); expect(f.send).toHaveBeenCalledTimes(2);
  const part = JSON.parse(readFileSync(target.file, "utf8")).overflow[0];
  rmSync(`${target.file}.${part}`);
  expect(() => new DurableDelivery(target)).toThrow("original data preserved");
});

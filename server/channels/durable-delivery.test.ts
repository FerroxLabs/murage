import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, rmdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as atomic from "../atomic.ts";
import { ChannelSendError, DurableDelivery } from "./durable-delivery.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0)) removeTempDirSync(p); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "murage-slack-ledger-")); roots.push(root);
  let now = 1000000000, current = true;
  const retained = new Map<string, { id: string }>();
  const enqueue = vi.fn(({ deliveryId }: { deliveryId: string; prompt: string }) => {
    const run = retained.get(deliveryId) ?? { id: "run-" + deliveryId }; retained.set(deliveryId, run); return run;
  });
  const result = vi.fn((_id: string): { status: string; output?: string; notice?: string } | null => ({ status: "completed", output: "Answer" }));
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
  expect(reserve).toHaveBeenCalledWith({ recipient: "DOWNER", text: "Answer", deliveryId: "event-1", purpose: "reply", attempt: 1 });
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

function stored(file: string) {
  const root = JSON.parse(readFileSync(file, "utf8"));
  const pages = (root.overflow ?? []).map((part: string) => JSON.parse(readFileSync(`${file}.${part}`, "utf8")));
  return { ...root, records: [root, ...pages].flatMap(page => page.records), tombstones: [root, ...pages].flatMap(page => page.tombstones) };
}
function seed(f: ReturnType<typeof fixture>, records: object[], tombstones: object[] = []) {
  writeFileSync(f.options.file, JSON.stringify({ version: 1, bindingKey: f.options.bindingKey, recipient: f.options.recipient, records, tombstones }));
}
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(["resend", "redact"] as const)("T-RESEND/T-REDACT: %s syncs page names and root before reclaiming old pages", action => {
  for (const barrier of ["overflow", "root"] as const) for (const fail of [false, true]) {
    const f = fixture(), options = { ...f.options, maxResponse: 20000 };
    seed(f, Array.from({ length: 110 }, (_, i) => ({ ...f.input, deliveryId: `old-${i}`, state: "uncertain", attempts: 1, response: "private".repeat(2800) })));
    // Include enough bytes to require an overflow page.
    DurableDelivery.consolidate(options, [], id => id, f.input.occurredAt);
    const ledger = new DurableDelivery(options), before = readFileSync(options.file, "utf8");
    const oldPages: string[] = JSON.parse(before).overflow.map((part: string) => `${options.file}.${part}`);
    const write = atomic.writeFileAtomic, durable: string[] = [];
    const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, bytes, opts) => {
      // Mutants: omit either syncDir, publish the root first, or reclaim before the root barrier.
      expect(opts?.syncDir).toBe(true);
      for (const page of oldPages) expect(readFileSync(page, "utf8")).toContain("private");
      if (file === options.file) {
        const pages = JSON.parse(String(bytes)).overflow.map((part: string) => `${file}.${part}`);
        expect(durable).toEqual(pages);
      }
      // Model a rename that completed but whose directory fsync reports EIO.
      if (fail && (file === options.file ? "root" : "overflow") === barrier) {
        write(file, bytes, { ...opts, syncDir: false });
        throw new Error("directory sync failed");
      }
      write(file, bytes, opts); durable.push(file);
    });
    const commit = () => action === "resend" ? ledger.resend("old-0") : ledger.redact("old-0");
    try {
      if (fail) expect(commit).toThrow("directory sync failed");
      else commit();
    } finally { spy.mockRestore(); }
    if (fail) {
      for (const page of oldPages) expect(readFileSync(page, "utf8")).toContain("private");
      // A power loss may restore the old root after the failed barrier.
      writeFileSync(options.file, before);
      expect(new DurableDelivery(options).status().uncertain).toBe(110);
    } else {
      expect(durable.at(-1)).toBe(options.file);
      for (const page of oldPages) expect(() => readFileSync(page)).toThrow();
      const restarted = new DurableDelivery(options);
      expect(stored(options.file).records[0]).toMatchObject({ state: "cancelled", prompt: "" });
      expect(restarted.status().pending).toBe(action === "resend" ? 1 : 0);
    }
  }
});

it.skip("T-RESEND/T-REDACT: Windows power-loss durability needs a real Windows runner; atomic.ts skips directory fsync on Windows and unsupported filesystems", () => {});

it("T-REDACT: a sweep retries the root directory barrier before reclaiming rollback pages", () => {
  for (const fail of [false, true]) {
    const f = fixture(), options = { ...f.options, maxResponse: 20000 };
    seed(f, Array.from({ length: 110 }, (_, i) => ({ ...f.input, deliveryId: `old-${i}`, state: "uncertain", attempts: 1, response: "private".repeat(2800) })));
    DurableDelivery.consolidate(options, [], id => id, f.input.occurredAt);
    const ledger = new DurableDelivery(options), before = readFileSync(options.file, "utf8");
    const oldPage = `${options.file}.${JSON.parse(before).overflow[0]}`, write = atomic.writeFileAtomic;
    const writeSpy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, bytes, opts) => {
      write(file, bytes, { ...opts, syncDir: false });
      if (file === options.file) throw new Error("directory sync failed");
    });
    try { expect(() => ledger.redact("old-109")).toThrow("directory sync failed"); }
    finally { writeSpy.mockRestore(); }
    const sync = atomic.syncParentDirectory;
    const barrier = vi.spyOn(atomic, "syncParentDirectory").mockImplementation(file => {
      expect(readFileSync(oldPage, "utf8")).toContain("private");
      if (fail) throw new Error("directory sync failed");
      sync(file);
    });
    try {
      // Mutant: sweep trusts a visible root whose rename was never made durable.
      expect(ledger.sweepPages()).toEqual(fail ? { removed: 0, failed: 1 } : { removed: 1, failed: 0 });
      expect(barrier).toHaveBeenCalledWith(options.file);
    } finally { barrier.mockRestore(); }
    if (fail) {
      expect(readFileSync(oldPage, "utf8")).toContain("private");
      expect(ledger.sweepPages()).toEqual({ removed: 1, failed: 0 });
    }
    expect(() => readFileSync(oldPage)).toThrow();
    expect(new DurableDelivery(options).isRedacted("old-109")).toBe(true);
  }
});

it.each(["redact", "settle"] as const)("T-REDACT: %s still cancels audio after ordinary reclamation", async action => {
  for (const cancel of [false, true]) {
    const f = fixture(), entered = held<void>(), gate = held<void>();
    const voiceNotes = () => ["a", "b"].map(name => ({ name, mime: "audio/mpeg", bytes: new Uint8Array([1]), text: "Hi", from: "Ember" }));
    const sendAudio = vi.fn(async ({ name }: { name: string }) => { if (name === "a") { entered.resolve(); await gate.promise; } });
    const ledger = new DurableDelivery({ ...f.options, runs: { ...f.options.runs, voiceNotes }, sendAudio });
    ledger.accept(f.input);
    const drain = ledger.drain(); await entered.promise;
    ledger.accept({ ...f.input, deliveryId: "incoming" });
    expect(stored(f.options.file).records.some((r: { deliveryId: string }) => r.deliveryId === f.input.deliveryId)).toBe(false);
    if (cancel) ledger[action](f.input.deliveryId);
    gate.resolve(); await drain;
    expect(sendAudio.mock.calls.map(([input]) => input.name)).toEqual(cancel ? ["a"] : ["a", "b"]);
    ledger.stop();
  }
});

it.each([false, true])("T-REDACT: WhatsApp voice notes survive ordinary sent-receipt reclamation (reject=%s)", async reject => {
  for (const cancel of ["none", "redact", "settle", "resend", "stop", "revoke", "invalidate"] as const) {
    for (const reclaim of [false, true]) {
      const f = fixture(), entered = held<void>(), gate = held<void>();
      const voiceNotes = vi.fn(() => ["a", "b", "c"].map(name => ({ name, mime: "audio/mpeg", bytes: new Uint8Array([1]), text: "Hi", from: "Ember" })));
      const sendAudio = vi.fn(async ({ name }: { name: string }) => { if (name === "a") { entered.resolve(); await gate.promise; } });
      const ledger = new DurableDelivery({ ...f.options, runs: { ...f.options.runs, voiceNotes }, sendAudio });
      ledger.accept(f.input);
      const drain = ledger.drain(); await entered.promise;
      if (cancel === "invalidate") f.invalidate();
      else if (cancel === "stop" || cancel === "revoke") ledger[cancel]();
      else if (cancel !== "none") ledger[cancel](f.input.deliveryId);
      if (reclaim && !["stop", "revoke", "invalidate"].includes(cancel)) {
        ledger.accept({ ...f.input, deliveryId: "incoming" });
        expect(stored(f.options.file).records.some((r: { deliveryId: string }) => r.deliveryId === f.input.deliveryId)).toBe(false);
      }
      if (reject) gate.reject(new ChannelSendError("forbidden", false)); else gate.resolve();
      await expect(drain).resolves.toBeUndefined();
      expect(sendAudio.mock.calls.map(([input]) => input.name)).toEqual(cancel === "none" ? ["a", "b", "c"] : ["a"]);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(voiceNotes).toHaveBeenCalledTimes(1);
      ledger.stop();
    }
  }
});

it("T-REDACT: an accepted prompt never starts a run after deletion", async () => {
  for (const redact of [false, true]) {
    const f = fixture(); f.ledger.accept(f.input);
    if (redact) expect(f.ledger.redact(f.input.deliveryId)).toEqual({});
    await f.ledger.drain();
    expect(f.enqueue).toHaveBeenCalledTimes(redact ? 0 : 1);
    expect(f.send).toHaveBeenCalledTimes(redact ? 0 : 1);
  }
});

it.each(["accepted", "queued", "uncertain", "rejected", "needs-review", "sent", "cancelled"])("T-REDACT: %s becomes inert and returns only its own run receipt", async state => {
  for (const redact of [false, true]) {
    const f = fixture();
    const record = { ...f.input, attempts: 0, state, ...(state !== "accepted" ? { runId: "target-run" } : {}),
      response: "private answer", quote: { id: "q", text: "private quote" }, media: [{ path: "/private/media", mime: "image/jpeg", bytes: 1 }] };
    seed(f, [record, { ...f.input, deliveryId: "other", state: "queued", attempts: 0, runId: "other-run" }]);
    const ledger = new DurableDelivery(f.options);
    if (redact) {
      expect(ledger.redact(f.input.deliveryId)).toEqual(state === "accepted" ? {} : { runId: "target-run" });
      expect(stored(f.options.file).records[0]).toMatchObject({ state: "cancelled", error: "redacted", prompt: "" });
      for (const field of ["response", "quote", "media"]) expect(stored(f.options.file).records[0]).not.toHaveProperty(field);
    }
    await ledger.drain();
    expect(f.send.mock.calls.filter(([input]) => input.text === "private answer")).toHaveLength(!redact && ["accepted", "queued"].includes(state) ? 1 : 0);
    expect(ledger.isRedacted(f.input.deliveryId)).toBe(redact);
    expect(ledger.isRedacted("missing")).toBe(true);
    expect(ledger.redact("missing")).toBeNull();
    await new DurableDelivery(f.options).drain();
    if (redact) expect(readFileSync(f.options.file, "utf8")).not.toContain("private");
  }
});

for (const purpose of ["notice", "reply"] as const) for (const stage of ["reserve", "send"] as const) {
  it.each([false, true])(`T-REDACT: ${purpose} ${stage} settlement cannot restore redacted or reclaimed records (reject=%s)`, async reject => {
    for (const redact of [false, true]) for (const reclaim of [false, true]) {
      const f = fixture(), entered = held<void>(), gate = held<void>();
      if (purpose === "notice") f.result.mockReturnValue({ status: "running", notice: "Wait" });
      const reserve = vi.fn(async () => { if (stage === "reserve") { entered.resolve(); await gate.promise; } return ["reserved"]; });
      f.send.mockImplementation(async () => { if (stage === "send") { entered.resolve(); await gate.promise; } return { recipient: "DOWNER", messageId: "ok" }; });
      const ledger = new DurableDelivery({ ...f.options, reserve, noticeAtMostOnce: true });
      ledger.accept(f.input);
      const drain = ledger.drain(); await entered.promise;
      if (redact) expect(ledger.redact(f.input.deliveryId)).toEqual({ runId: "run-event-1" });
      if (reclaim) ledger.accept({ ...f.input, deliveryId: "next" });
      if (reject) gate.reject(new ChannelSendError("offline", false)); else gate.resolve();
      await expect(drain).resolves.toBeUndefined();
      const row = stored(f.options.file).records.find((r: { deliveryId: string }) => r.deliveryId === f.input.deliveryId);
      if (redact) {
        if (reclaim) expect(row).toBeUndefined();
        else { expect(row).toMatchObject({ state: "cancelled", error: "redacted", prompt: "" }); expect(row).not.toHaveProperty("response"); }
        expect(f.send).toHaveBeenCalledTimes(stage === "send" ? 1 : 0);
        expect(ledger.isRedacted(f.input.deliveryId)).toBe(true);
      } else {
        expect(row.state).toBe(purpose === "notice" || reject ? "queued" : "sent");
        expect(f.send).toHaveBeenCalledTimes(stage === "reserve" && reject ? 0 : 1);
      }
    }
  });
}

it.each(["accepted", "sent"])("T-REDACT: loop-top lookup skips a reclaimed %s snapshot row", async state => {
  for (const reclaim of [false, true]) {
    const f = fixture(), gate = held<{ recipient: string; messageId: string }>();
    seed(f, [{ ...f.input, deliveryId: "A", state: "accepted", attempts: 0, response: "A" },
      { ...f.input, deliveryId: "B", state, attempts: 0, response: "B" }]);
    const ledger = new DurableDelivery(f.options);
    f.send.mockReturnValueOnce(gate.promise);
    const drain = ledger.drain();
    if (reclaim) {
      if (state === "accepted") ledger.redact("B");
      ledger.accept({ ...f.input, deliveryId: "C", response: "C" });
    }
    gate.resolve({ recipient: "DOWNER", messageId: "ok" });
    await expect(drain).resolves.toBeUndefined();
    await ledger.drain();
    expect(f.send.mock.calls.map(([input]) => input.text)).toEqual(reclaim ? ["A", "C"] : state === "accepted" ? ["A", "B"] : ["A"]);
  }
});

it("T-REDACT: page sweeps preserve referenced pages, reclaim plaintext and count retryable failures", () => {
  const f = fixture(), options = { ...f.options, maxResponse: 20000 };
  seed(f, Array.from({ length: 110 }, (_, i) => ({ ...f.input, deliveryId: `page-${i}`, state: "uncertain", attempts: 1, response: "secret".repeat(3300) })));
  DurableDelivery.consolidate(options, [], id => id, f.input.occurredAt);
  const referenced = JSON.parse(readFileSync(options.file, "utf8")).overflow[0];
  const orphan = `${options.file}.orphan`, failed = `${options.file}.failed`;
  writeFileSync(orphan, "private orphan"); mkdirSync(failed); writeFileSync(join(failed, "busy"), "busy");
  const ledger = new DurableDelivery(options);
  expect(readdirSync(roots.at(-1)!)).not.toContain("ledger.json.orphan");
  expect(readFileSync(`${options.file}.${referenced}`, "utf8")).toContain("secret");
  expect(ledger.pageSweepFailures).toBe(1);
  expect(ledger.sweepPages()).toEqual({ removed: 0, failed: 1 });
  rmSync(join(failed, "busy")); rmdirSync(failed); writeFileSync(failed, "private orphan");
  expect(ledger.sweepPages()).toEqual({ removed: 1, failed: 0 });
  writeFileSync(orphan, "private orphan"); ledger.redact("page-109");
  expect(readdirSync(roots.at(-1)!)).not.toContain("ledger.json.orphan");
  const row = stored(options.file).records.find((r: { deliveryId: string }) => r.deliveryId === "page-109");
  expect(row).toMatchObject({ state: "cancelled", error: "redacted" }); expect(row).not.toHaveProperty("response");
  const live = new Set(["ledger.json", ...(JSON.parse(readFileSync(options.file, "utf8")).overflow ?? []).map((p: string) => `ledger.json.${p}`)]);
  expect(readdirSync(roots.at(-1)!)).toEqual(expect.arrayContaining([...live]));
  expect(readdirSync(roots.at(-1)!).length).toBe(live.size);
});

it.each([0, 20])("T-STUCK: backpressure drains replay in order with %s unreviewed replies", async reviews => {
  const f = fixture();
  seed(f, Array.from({ length: reviews }, (_, i) => ({ ...f.input, deliveryId: `review-${i}`, state: "uncertain", attempts: 1, response: "held" })));
  const ledger = new DurableDelivery(f.options), total = reviews ? 190 : 250;
  let admitted = 0;
  while (admitted < total) {
    while (admitted < total && ledger.admissionCapacity().records < 190 && ledger.admissionCapacity().tombstones < 10000) {
      ledger.accept({ ...f.input, deliveryId: `replay-${admitted}`, response: `reply-${admitted}` }); admitted++;
    }
    await ledger.drain();
  }
  expect(f.send.mock.calls.map(([input]) => input.text)).toEqual(Array.from({ length: total }, (_, i) => `reply-${i}`));
  expect(ledger.admissionCapacity()).toEqual({ records: reviews, tombstones: total });
  expect(ledger.status().uncertain).toBe(reviews);
  if (reviews) {
    ledger.settle("review-0");
    expect(stored(f.options.file).records.find((r: { deliveryId: string }) => r.deliveryId === "review-0")).toMatchObject({ state: "cancelled", error: "reviewed", prompt: "" });
    expect(ledger.admissionCapacity()).toEqual({ records: reviews - 1, tombstones: total + 1 });
  }
});

it.each([9999, 10000])("T-STUCK: tombstone occupancy %s uses accept accounting and resumes after expiry", count => {
  const f = fixture();
  seed(f, [], Array.from({ length: count }, (_, i) => ({ deliveryId: `old-${i}`, occurredAt: f.input.occurredAt })));
  const ledger = new DurableDelivery(f.options), before = atomic.atomicWriteCount(f.options.file);
  expect(ledger.admissionCapacity()).toEqual({ records: 0, tombstones: count });
  expect(atomic.atomicWriteCount(f.options.file)).toBe(before);
  if (count === 10000) expect(() => ledger.accept(f.input)).toThrow("pending receipt limit");
  else expect(ledger.accept(f.input)).toBe("accepted");
  f.advance(7 * 86400000 + 1);
  expect(ledger.admissionCapacity().tombstones).toBe(0);
  expect(ledger.accept({ ...f.input, deliveryId: "fresh", occurredAt: f.options.now() })).toBe("accepted");
});

it.each(["uncertain", "rejected", "needs-review"])("T-STUCK: settling %s frees a full ledger without removing metadata", state => {
  const f = fixture();
  seed(f, Array.from({ length: 200 }, (_, i) => ({ ...f.input, deliveryId: `held-${i}`, state, attempts: 1, response: "answer", runId: `run-${i}`, quote: { id: "q" } })));
  const ledger = new DurableDelivery(f.options);
  expect(ledger.admissionCapacity().records).toBe(200);
  expect(() => ledger.accept(f.input)).toThrow("pending receipt limit");
  ledger.settle("held-0");
  expect(stored(f.options.file).records[0]).toEqual({ ...f.input, deliveryId: "held-0", state: "cancelled", error: "reviewed", prompt: "", attempts: 1, runId: "run-0", quote: { id: "q" } });
  expect(ledger.admissionCapacity()).toEqual({ records: 199, tombstones: 1 });
  expect(ledger.accept(f.input)).toBe("accepted");
});

it.each(["none", "before-overflow", "before-root", "after-root"])("T-RESEND: atomic replacement survives %s crash and repeated requests", async crash => {
  const f = fixture(), options = { ...f.options, maxResponse: 20000 };
  seed(f, Array.from({ length: 110 }, (_, i) => ({ ...f.input, deliveryId: `old-${i}`, state: "uncertain", attempts: 1, response: `answer-${i}:` + "x".repeat(19500), runId: `run-${i}` })));
  DurableDelivery.consolidate(options, [], id => id, f.input.occurredAt);
  const ledger = new DurableDelivery(options), old = stored(options.file).records[0];
  f.advance(8 * 86400000);
  const write = atomic.writeFileAtomic, rootWrites: string[] = [];
  const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((file, bytes, opts) => {
    if (crash === "before-overflow" && file !== options.file || crash === "before-root" && file === options.file) throw new Error("crash");
    write(file, bytes, opts);
    if (file === options.file) { rootWrites.push(String(bytes)); if (crash === "after-root") throw new Error("crash"); }
  });
  if (crash === "none") expect(ledger.resend("old-0")).toBe("resent");
  else expect(() => ledger.resend("old-0")).toThrow("crash");
  spy.mockRestore();
  const committed = crash === "none" || crash === "after-root";
  let disk = stored(options.file);
  expect(disk.records.find((r: { deliveryId: string }) => r.deliveryId === "old-0")).toMatchObject(committed ? { state: "cancelled", error: "reviewed", prompt: "" } : old);
  expect(disk.records.filter((r: { response?: string }) => r.response === old.response)).toHaveLength(1);
  expect(rootWrites).toHaveLength(committed ? 1 : 0);
  const restarted = new DurableDelivery(options);
  expect(restarted.resend("old-0")).toBe(committed ? "already" : "resent");
  const before = atomic.atomicWriteCount(options.file);
  expect(restarted.resend("old-0")).toBe("already");
  expect(atomic.atomicWriteCount(options.file)).toBe(before);
  disk = stored(options.file);
  const replacement = disk.records.filter((r: { deliveryId: string }) => !r.deliveryId.startsWith("old-"));
  expect(replacement).toHaveLength(1);
  expect(replacement[0]).toMatchObject({ state: "accepted", prompt: old.prompt, response: old.response, attempts: 0, occurredAt: f.options.now() });
  expect(replacement[0].deliveryId).toMatch(/^[a-f0-9]{64}$/);
  expect(replacement[0]).not.toHaveProperty("runId"); expect(replacement[0]).not.toHaveProperty("dedupeId");
  expect(disk.records.find((r: { deliveryId: string }) => r.deliveryId === "old-0")).not.toHaveProperty("response");
  await restarted.drain(); expect(f.enqueue).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0][0].text).toBe(old.response);
});

it.each([199, 200])("T-RESEND: %s occupied records preserves the reply until capacity permits one commit", count => {
  const f = fixture();
  seed(f, Array.from({ length: 199 }, (_, i) => ({ ...f.input, deliveryId: `held-${i}`, state: "uncertain", attempts: 1, response: "Answer" })));
  const disk = stored(f.options.file);
  // The paired fixture differs only in whether the last slot is reclaimable.
  disk.records.push({ ...f.input, deliveryId: "last", state: count === 199 ? "sent" : "uncertain", attempts: 1, response: "last" });
  writeFileSync(f.options.file, JSON.stringify(disk));
  const ledger = new DurableDelivery(f.options), before = readFileSync(f.options.file, "utf8");
  const spy = vi.spyOn(atomic, "writeFileAtomic");
  expect(ledger.resend("held-0")).toBe(count === 199 ? "resent" : "full");
  expect(spy).toHaveBeenCalledTimes(count === 199 ? 1 : 0);
  if (count === 200) {
    expect(readFileSync(f.options.file, "utf8")).toBe(before);
    ledger.settle("last"); expect(ledger.resend("held-0")).toBe("resent");
  }
  expect(stored(f.options.file).records.find((r: { deliveryId: string }) => r.deliveryId === "held-0")).toMatchObject({ state: "cancelled", error: "reviewed", prompt: "" });
});

it.each([false, true])("T-RESEND: an existing replacement settles only the original (tombstone=%s)", tombstone => {
  const f = fixture(); f.ledger.accept({ ...f.input, response: "Answer" });
  expect(f.ledger.resend(f.input.deliveryId)).toBe("resent");
  const disk = stored(f.options.file), replacement = disk.records[1];
  disk.records[0] = { ...f.input, state: "uncertain", response: "Answer", attempts: 1 };
  if (tombstone) { disk.records.pop(); disk.tombstones.push({ deliveryId: replacement.deliveryId, occurredAt: replacement.occurredAt }); }
  writeFileSync(f.options.file, JSON.stringify(disk));
  const ledger = new DurableDelivery(f.options), spy = vi.spyOn(atomic, "writeFileAtomic");
  expect(ledger.resend(f.input.deliveryId)).toBe("already"); expect(spy).toHaveBeenCalledTimes(1);
  expect(stored(f.options.file).records[0]).toMatchObject({ state: "cancelled", error: "reviewed", prompt: "" });
  expect(ledger.resend(f.input.deliveryId)).toBe("already");
  expect(ledger.resend("absent")).toBe("already");
  expect(spy).toHaveBeenCalledTimes(1);
  expect(ledger.has(replacement.deliveryId)).toBe(true);
});

it("T-RESEND: replacement identity depends only on the source, and a replacement has its own resend", () => {
  const ids: string[] = [];
  for (const priorResend of [false, true]) {
    const f = fixture();
    f.ledger.accept({ ...f.input, response: "Answer" });
    f.ledger.accept({ ...f.input, deliveryId: "unrelated", response: "Other" });
    if (priorResend) f.ledger.resend("unrelated");
    expect(f.ledger.resend(f.input.deliveryId)).toBe("resent");
    const replacement = stored(f.options.file).records.find((r: { response?: string }) => r.response === "Answer");
    ids.push(replacement.deliveryId);
    expect(f.ledger.resend(replacement.deliveryId)).toBe("resent");
    const next = stored(f.options.file).records.find((r: { response?: string }) => r.response === "Answer");
    expect(next.deliveryId).not.toBe(replacement.deliveryId);
    expect(f.ledger.resend(replacement.deliveryId)).toBe("already");
  }
  expect(ids[0]).toBe(ids[1]);
});

it.each(["uncertain", "sent"])("T-RESEND: the source ends reviewed even when originally %s", state => {
  const f = fixture();
  seed(f, [{ ...f.input, state, attempts: 1, response: "Answer" }]);
  const ledger = new DurableDelivery(f.options);
  expect(ledger.resend(f.input.deliveryId)).toBe("resent");
  expect(stored(f.options.file).records.find((r: { deliveryId: string }) => r.deliveryId === f.input.deliveryId))
    .toMatchObject({ state: "cancelled", error: "reviewed", prompt: "" });
  expect(new DurableDelivery(f.options).resend(f.input.deliveryId)).toBe("already");
});

it("T-RESEND: a root write failure preserves the in-memory source for retry", () => {
  const f = fixture(); f.ledger.accept({ ...f.input, response: "Answer" });
  const before = readFileSync(f.options.file, "utf8");
  const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => { throw new Error("disk full"); });
  expect(() => f.ledger.resend(f.input.deliveryId)).toThrow("disk full");
  expect(readFileSync(f.options.file, "utf8")).toBe(before);
  spy.mockRestore();
  expect(f.ledger.resend(f.input.deliveryId)).toBe("resent");
  expect(stored(f.options.file).records.filter((r: { response?: string }) => r.response === "Answer")).toHaveLength(1);
});

it("T-RESEND: a full tombstone window makes no write and preserves the old reply", () => {
  const f = fixture();
  seed(f, [{ ...f.input, state: "uncertain", attempts: 1, response: "Answer" }],
    Array.from({ length: 10000 }, (_, i) => ({ deliveryId: `t-${i}`, occurredAt: f.input.occurredAt })));
  const ledger = new DurableDelivery(f.options), before = readFileSync(f.options.file, "utf8"), spy = vi.spyOn(atomic, "writeFileAtomic");
  expect(ledger.resend(f.input.deliveryId)).toBe("full"); expect(spy).not.toHaveBeenCalled();
  expect(readFileSync(f.options.file, "utf8")).toBe(before);
  f.advance(7 * 86400000 + 1);
  expect(ledger.resend(f.input.deliveryId)).toBe("resent"); expect(spy).toHaveBeenCalledTimes(1);
});

it.each([false, true])("T-NOTICE-ONCE: opt-in persists before reserve; WhatsApp keeps retrying (enabled=%s)", async enabled => {
  for (const failure of ["reserve", "send", "crash"] as const) {
    const f = fixture(); f.result.mockReturnValue({ status: "running", notice: "Wait" });
    const reserve = vi.fn(async () => {
      expect(stored(f.options.file).records[0].noticeSent === true).toBe(enabled);
      if (failure === "reserve") throw new Error("failed");
      return ["notice"];
    });
    f.send.mockImplementation(async () => { if (failure === "crash") f.invalidate(); throw new Error("answer lost"); });
    const options = { ...f.options, reserve, noticeAtMostOnce: enabled };
    const ledger = new DurableDelivery(options); ledger.accept(f.input); await ledger.drain();
    const restarted = new DurableDelivery({ ...options, isCurrent: () => true });
    await restarted.drain(); await restarted.drain();
    expect(reserve).toHaveBeenCalledTimes(enabled ? 1 : 3);
    expect(f.send).toHaveBeenCalledTimes(failure === "reserve" ? 0 : enabled ? 1 : 3);
  }
});

it("T-HOOK-ID: identical replies, notice and restart retry have distinct stable attempt identities", async () => {
  const f = fixture(), reserve = vi.fn(async (_input: object) => ["reserved"]);
  const options = { ...f.options, reserve, noticeAtMostOnce: true };
  const ledger = new DurableDelivery(options); ledger.accept(f.input);
  f.result.mockReturnValueOnce({ status: "running", notice: "Answer" }); await ledger.drain();
  f.send.mockRejectedValueOnce(new ChannelSendError("offline", false)); await ledger.drain();
  f.advance(3000);
  const restarted = new DurableDelivery(options); await restarted.drain();
  restarted.accept({ ...f.input, deliveryId: "second" }); await restarted.drain();
  const identities = [
    { deliveryId: "event-1", purpose: "notice", attempt: 1 },
    { deliveryId: "event-1", purpose: "reply", attempt: 1 },
    { deliveryId: "event-1", purpose: "reply", attempt: 2 },
    { deliveryId: "second", purpose: "reply", attempt: 1 },
  ];
  identities.forEach((identity, i) => {
    expect(reserve.mock.calls[i][0]).toEqual({ ...identity, recipient: "DOWNER", text: "Answer" });
    expect(f.send.mock.calls[i][0]).toMatchObject({ ...identity, recipient: "DOWNER", text: "Answer", reserved: ["reserved"] });
  });
});

it.each([undefined, 7, -1, NaN])("T-RL-DEADLINE: uncertain rate limits retain response and cooldown across restart (%s)", async delay => {
  const f = fixture(); f.send.mockRejectedValue(new ChannelSendError("rate-limit", true, delay));
  f.ledger.accept(f.input); await f.ledger.drain();
  expect(stored(f.options.file).records[0]).toMatchObject({ state: "uncertain", response: "Answer", resendAfter: f.options.now() + (delay === 7 ? 7 : 60) * 1000 });
  await new DurableDelivery(f.options).drain(); expect(f.send).toHaveBeenCalledTimes(1);
});


it("T-RESEND-LINEAGE: redaction reaches a resend chain after ancestors are reclaimed and restart", async () => {
  const f = fixture(); f.ledger.accept({ ...f.input, response: "private answer" });
  expect(f.ledger.resend(f.input.deliveryId)).toBe("resent");
  const first = stored(f.options.file).records.find((r: { state: string }) => r.state === "accepted").deliveryId;
  expect(f.ledger.resend(first)).toBe("resent");
  f.ledger.accept({ ...f.input, deliveryId: "unrelated", prompt: "safe", response: "safe" });
  f.ledger.stop();
  const ledger = new DurableDelivery(f.options);
  expect(stored(f.options.file).records.some((r: { deliveryId: string }) => r.deliveryId === f.input.deliveryId)).toBe(false);
  ledger.redact(f.input.deliveryId);
  expect(readFileSync(f.options.file, "utf8")).not.toContain("private answer");
  await ledger.drain();
  expect(f.send.mock.calls.map(([input]) => input.text)).toEqual(["safe"]);
});

it("T-RESEND-LINEAGE: legacy deterministic replacements recover lineage through reclaimed ancestors", async () => {
  const f = fixture(); f.ledger.accept({ ...f.input, response: "legacy private answer" });
  f.ledger.resend(f.input.deliveryId);
  const first = stored(f.options.file).records.find((r: { state: string }) => r.state === "accepted").deliveryId;
  f.ledger.resend(first); f.ledger.accept({ ...f.input, deliveryId: "safe", prompt: "safe", response: "safe" });
  f.ledger.stop();
  const legacy = stored(f.options.file);
  for (const row of [...legacy.records, ...legacy.tombstones]) delete row.sourceDeliveryId;
  writeFileSync(f.options.file, JSON.stringify(legacy));
  const ledger = new DurableDelivery(f.options); ledger.redact(f.input.deliveryId);
  expect(readFileSync(f.options.file, "utf8")).not.toContain("legacy private answer");
  await ledger.drain(); expect(f.send.mock.calls.map(([input]) => input.text)).toEqual(["safe"]);
});

it("T-EXPIRY-MONOTONIC: one commit lowers records, descendants and tombstones, never raises or clears", () => {
  const f = fixture(), deadline = f.options.now() + 10000;
  f.ledger.accept(f.input); f.ledger.resend(f.input.deliveryId);
  f.ledger.accept({ ...f.input, deliveryId: "unrelated" }); // Reclaim the source as a tombstone.
  const before = JSON.parse(readFileSync(f.options.file, "utf8"));
  const copy = before.records.find((r: { sourceDeliveryId?: string }) => r.sourceDeliveryId);
  const write = vi.spyOn(atomic, "writeFileAtomic");
  expect(f.ledger.setExpiry(f.input.deliveryId, deadline)).toBe(true);
  expect(write).toHaveBeenCalledTimes(1); write.mockClear();
  expect(f.ledger.setExpiry(f.input.deliveryId, deadline + 10000)).toBe(true);
  expect(write).not.toHaveBeenCalled();
  let disk = JSON.parse(readFileSync(f.options.file, "utf8"));
  expect(disk.tombstones[0].expiresAt).toBe(deadline);
  expect(disk.records.find((r: { deliveryId: string }) => r.deliveryId === copy.deliveryId).expiresAt).toBe(deadline);
  expect(disk.records.find((r: { deliveryId: string }) => r.deliveryId === "unrelated").expiresAt).toBeUndefined();
  expect(f.ledger.setExpiry(f.input.deliveryId, deadline - 1000)).toBe(true);
  expect(f.ledger.setExpiry("missing", deadline)).toBe(false);
  expect(() => {
    // @ts-expect-error A deadline cannot be cleared, including by an untyped caller.
    f.ledger.setExpiry(f.input.deliveryId, undefined);
  }).toThrow();
  disk = JSON.parse(readFileSync(f.options.file, "utf8"));
  expect(disk.tombstones[0].expiresAt).toBe(deadline - 1000);
  expect(new DurableDelivery(f.options).setExpiry(f.input.deliveryId, deadline)).toBe(true);
});

it("T-EXPIRY-LINEAGE: legacy migration and resend inherit the minimum over the full lineage", () => {
  const f = fixture(), deadline = f.options.now() + 10000;
  f.ledger.accept({ ...f.input, expiresAt: deadline }); f.ledger.resend(f.input.deliveryId);
  const disk = JSON.parse(readFileSync(f.options.file, "utf8")), copy = disk.records[1];
  // A pre-fix deterministic replacement lacks both lineage and deadline.
  delete copy.sourceDeliveryId; delete copy.expiresAt;
  writeFileSync(f.options.file, JSON.stringify(disk));
  const migrated = new DurableDelivery(f.options);
  expect(JSON.parse(readFileSync(f.options.file, "utf8")).records[1].expiresAt).toBe(deadline);
  // A newly admitted linked descendant can have a later deadline: resend must still inspect its ancestors.
  migrated.accept({ ...f.input, deliveryId: "descendant", expiresAt: deadline + 10000, ...{ sourceDeliveryId: copy.deliveryId } });
  expect(migrated.resend("descendant")).toBe("resent");
  const rows = JSON.parse(readFileSync(f.options.file, "utf8")).records;
  expect(rows.at(-1).expiresAt).toBe(deadline);
});

it("T-EXPIRY-ATOMIC: a failed deadline commit leaves no partial descendant update", () => {
  const f = fixture(), deadline = f.options.now() + 10000;
  f.ledger.accept(f.input); f.ledger.resend(f.input.deliveryId);
  const original = readFileSync(f.options.file, "utf8");
  const spy = vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw new Error("disk full"); });
  expect(() => f.ledger.setExpiry(f.input.deliveryId, deadline)).toThrow("disk full");
  spy.mockRestore(); expect(readFileSync(f.options.file, "utf8")).toBe(original);
  expect(f.ledger.setExpiry(f.input.deliveryId, deadline)).toBe(true);
  expect(JSON.parse(readFileSync(f.options.file, "utf8")).records.every((r: { expiresAt?: number }) => r.expiresAt === deadline)).toBe(true);
});

it("T-EXPIRY-RECLAIM: future tombstone deadlines survive age reclamation and restart", () => {
  const f = fixture(), expiresAt = f.options.now() + 9 * 86400000;
  f.ledger.accept({ ...f.input, expiresAt }); f.ledger.settle(f.input.deliveryId);
  f.advance(7 * 86400000 + 60000);
  f.ledger.accept({ ...f.input, deliveryId: "fresh", occurredAt: f.options.now() });
  expect(stored(f.options.file).tombstones).toContainEqual(expect.objectContaining({ deliveryId: f.input.deliveryId, expiresAt }));
  const ledger = new DurableDelivery(f.options);
  expect(ledger.setExpiry(f.input.deliveryId, expiresAt + 10000)).toBe(true);
  expect(stored(f.options.file).tombstones[0].expiresAt).toBe(expiresAt);
});

it.each([false, true])("T-EXPIRY-FAMILY-MIN: minimum covers every copy with absent root=%s", absent => {
  const f = fixture(), expiresAt = f.options.now() + 10000;
  f.ledger.accept(f.input);
  const disk = stored(f.options.file);
  disk.records = [
    ...(absent ? [] : [disk.records[0]]),
    { ...disk.records[0], deliveryId: "child", sourceDeliveryId: f.input.deliveryId, expiresAt },
    { ...disk.records[0], deliveryId: "sibling", sourceDeliveryId: f.input.deliveryId, expiresAt: expiresAt + 5000 },
    { ...disk.records[0], deliveryId: "grandchild", sourceDeliveryId: "child" },
  ];
  writeFileSync(f.options.file, JSON.stringify(disk));
  const ledger = new DurableDelivery(f.options);
  expect(ledger.setExpiry(f.input.deliveryId, expiresAt + 20000)).toBe(true);
  expect(stored(f.options.file).records.every((r: { expiresAt?: number }) => r.expiresAt === expiresAt)).toBe(true);
  ledger.resend("sibling");
  expect(stored(f.options.file).records.at(-1).expiresAt).toBe(expiresAt);
});

it("T-EXPIRY-MIGRATION-ENOENT: constructor cannot swallow a migration write failure", () => {
  const f = fixture(); f.ledger.accept(f.input);
  const disk = stored(f.options.file); disk.records[0].state = "sending";
  writeFileSync(f.options.file, JSON.stringify(disk));
  vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw Object.assign(new Error("missing directory"), { code: "ENOENT" }); });
  expect(() => new DurableDelivery(f.options)).toThrow("original data preserved");
});

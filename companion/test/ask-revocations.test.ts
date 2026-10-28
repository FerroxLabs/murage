// S28: the durable queue that carries { deviceId, through } to the harness. Same pattern as push-revocations, keyed by device with the highest through kept.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { askRevokeSender, createAskRevocations } from "../src/ask-revocations.ts";
import { removeTempDirSync } from "../../server/testing/cleanup.ts";

const dir = mkdtempSync(join(tmpdir(), "ask-revocations-test-"));
afterAll(() => removeTempDirSync(dir));
let n = 0;
const fileName = () => join(dir, `q${++n}.json`);
const onDisk = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Entry = { deviceId: string; through: number };

describe("createAskRevocations", () => {
  it("add writes the entry down and sends it at once; the ack clears it", async () => {
    const file = fileName();
    const sent: Entry[] = [];
    const q = createAskRevocations({ file, send: async (e) => { sent.push(e); return true; }, retryMs: 20 });
    q.add({ deviceId: "devA", through: 3 });
    expect(onDisk(file)).toEqual([{ deviceId: "devA", through: 3 }]);
    await q.acked("devA");
    expect(sent).toEqual([{ deviceId: "devA", through: 3 }]);
    expect(q.pending()).toEqual([]);
    expect(onDisk(file)).toEqual([]);
  });

  it("a harness that is down keeps the entry on disk and retries until it answers", async () => {
    const file = fileName();
    let up = false;
    const send = vi.fn(async () => up);
    const q = createAskRevocations({ file, send, retryMs: 15 });
    q.add({ deviceId: "devA", through: 1 });
    await wait(80);
    expect(send.mock.calls.length).toBeGreaterThan(1);
    expect(q.pending()).toEqual([{ deviceId: "devA", through: 1 }]);
    expect(onDisk(file)).toEqual([{ deviceId: "devA", through: 1 }]);
    up = true;
    await q.acked("devA");
    expect(onDisk(file)).toEqual([]);
  });

  it("acked does not resolve while the entry is pending, and resolves at once for a device with nothing pending", async () => {
    const q = createAskRevocations({ file: fileName(), send: async () => false, retryMs: 10_000 });
    await q.acked("nobody");
    q.add({ deviceId: "devA", through: 1 });
    let done = false;
    void q.acked("devA").then(() => { done = true; });
    await wait(40);
    expect(done).toBe(false);
  });

  it("keeps the highest through per device after two revokes, in either order", () => {
    const q = createAskRevocations({ file: fileName(), send: async () => false, retryMs: 10_000 });
    q.add({ deviceId: "devA", through: 3 });
    q.add({ deviceId: "devA", through: 5 });
    q.add({ deviceId: "devA", through: 4 });
    q.add({ deviceId: "devB", through: 2 });
    expect(q.pending()).toEqual([{ deviceId: "devA", through: 5 }, { deviceId: "devB", through: 2 }]);
  });

  it("a through that arrives while a lower one is on the wire is not cleared by the lower one's answer", async () => {
    const file = fileName();
    const sent: Entry[] = [];
    let release: (v: boolean) => void = () => {};
    const q = createAskRevocations({ file, retryMs: 10_000, send: (e) => { sent.push(e); return sent.length === 1 ? new Promise<boolean>((r) => { release = r; }) : Promise.resolve(true); } });
    q.add({ deviceId: "devA", through: 2 });
    q.add({ deviceId: "devA", through: 6 });
    await wait(20);
    release(true);
    await q.acked("devA");
    expect(sent).toEqual([{ deviceId: "devA", through: 2 }, { deviceId: "devA", through: 6 }]);
    expect(q.pending()).toEqual([]);
  });

  it("a restart of the door with a pending entry sends it", async () => {
    const file = fileName();
    writeFileSync(file, JSON.stringify([{ deviceId: "devA", through: 9 }]));
    const sent: Entry[] = [];
    const q = createAskRevocations({ file, send: async (e) => { sent.push(e); return true; }, retryMs: 20 });
    expect(q.pending()).toEqual([{ deviceId: "devA", through: 9 }]);
    await q.acked("devA");
    expect(sent).toEqual([{ deviceId: "devA", through: 9 }]);
  });

  it("ignores corrupt entries in the file, and a file that is not a list", () => {
    const file = fileName();
    writeFileSync(file, JSON.stringify([{ deviceId: "ok_1", through: 2 }, { deviceId: "bad id", through: 1 }, { deviceId: "x", through: -1 }, { deviceId: "y", through: 1.5 }, { deviceId: 5, through: 1 }, null]));
    expect(createAskRevocations({ file, send: async () => false, retryMs: 10_000 }).pending()).toEqual([{ deviceId: "ok_1", through: 2 }]);
    writeFileSync(file, "{not json");
    expect(createAskRevocations({ file, send: async () => false, retryMs: 10_000 }).pending()).toEqual([]);
  });

  it("a send that never settles counts as a failure after sendTimeoutMs, and a throw does too", async () => {
    let calls = 0;
    const q = createAskRevocations({ file: fileName(), retryMs: 15, sendTimeoutMs: 20, send: () => { calls++; if (calls === 1) return new Promise<boolean>(() => {}); if (calls === 2) throw new Error("down"); return Promise.resolve(true); } });
    q.add({ deviceId: "devA", through: 1 });
    await q.acked("devA");
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

// Fix 1 (Grok review): only a 200 with ok:true is an acknowledgement. A 404 is acknowledged only when the harness itself says
// share and ask is not offered; every other 404, error or timeout leaves the entry queued.
describe("createAskRevocations: a queue file that cannot be trusted is never replaced", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("a missing file starts empty", () => {
    const q = createAskRevocations({ file: fileName(), send: async () => true });
    expect(q.pending()).toEqual([]);
  });

  it.each([
    ["not JSON", "{not json"],
    ["not an array", JSON.stringify({ deviceId: "devA", through: 1 })],
  ])("%s: the file is left byte for byte, nothing is written over it, add is held back, and one line is logged without ids", async (_n, body) => {
    const file = fileName();
    writeFileSync(file, body);
    const spy = quiet();
    try {
      const send = vi.fn(async () => false);
      const q = createAskRevocations({ file, send, retryMs: 10 });
      q.add({ deviceId: "devA", through: 2 });
      await wait(40);
      expect(readFileSync(file, "utf8")).toBe(body);
      expect(spy.mock.calls.length).toBe(1);
      expect(JSON.stringify(spy.mock.calls)).not.toContain("devA");
      // still owed in memory for this run
      expect(q.pending()).toEqual([{ deviceId: "devA", through: 2 }]);
    } finally { spy.mockRestore(); }
  });

  it("an unreadable path (a directory) is not ENOENT: kept, not replaced", () => {
    const file = fileName();
    mkdirSync(file);
    const spy = quiet();
    try {
      const q = createAskRevocations({ file, send: async () => false, retryMs: 1000 });
      q.add({ deviceId: "devA", through: 1 });
      expect(statSync(file).isDirectory()).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it("a bad entry among good ones is quarantined to a side file, the good ones are kept and sent", async () => {
    const file = fileName();
    writeFileSync(file, JSON.stringify([{ deviceId: "devA", through: 4 }, { deviceId: "../x", through: 1 }, 7]));
    const spy = quiet();
    try {
      const sent: Entry[] = [];
      const q = createAskRevocations({ file, send: async (e) => { sent.push(e); return true; }, retryMs: 10 });
      await q.acked("devA");
      expect(sent).toEqual([{ deviceId: "devA", through: 4 }]);
      const quarantine = JSON.parse(readFileSync(`${file}.bad`, "utf8"));
      expect(quarantine).toEqual([{ deviceId: "../x", through: 1 }, 7]);
      expect(JSON.stringify(spy.mock.calls)).not.toContain("devA");
    } finally { spy.mockRestore(); }
  });
});

describe("askRevokeSender", () => {
  const PROOF = "a".repeat(64);
  type Req = { method: string; path: string };
  const sender = (answers: Record<string, { status: number; body: unknown } | "throw">) => {
    const calls: Req[] = [];
    const harness = async (req: Req) => {
      calls.push({ method: req.method, path: req.path });
      const a = answers[`${req.method} ${req.path}`] ?? { status: 404, body: {} };
      if (a === "throw") throw new Error("down");
      return a;
    };
    return { calls, send: askRevokeSender(harness as never, PROOF) };
  };
  const entry = { deviceId: "devA", through: 2 };

  it("a 200 with ok:true acknowledges", async () => {
    const s = sender({ "POST /api/phones/ask-revoke": { status: 200, body: { ok: true } } });
    expect(await s.send(entry)).toBe(true);
    expect(s.calls).toEqual([{ method: "POST", path: "/api/phones/ask-revoke" }]);
  });

  it("a 200 without ok:true stays queued", async () => {
    const s = sender({ "POST /api/phones/ask-revoke": { status: 200, body: {} } });
    expect(await s.send(entry)).toBe(false);
  });

  it("a 404 while the harness still offers share and ask stays queued", async () => {
    const s = sender({ "GET /api/phones/offered": { status: 200, body: { offered: true, shareAsk: true } } });
    expect(await s.send(entry)).toBe(false);
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/phones/ask-revoke", "GET /api/phones/offered"]);
  });

  it("a 404 while the harness says shareAsk is off is reported as not offered, never as an acknowledgement", async () => {
    const s = sender({ "GET /api/phones/offered": { status: 200, body: { offered: true, shareAsk: false } } });
    expect(await s.send(entry)).toBe("not-offered");
  });

  it("a 404 whose offered probe fails (404, error, throw) stays queued", async () => {
    expect(await sender({ "GET /api/phones/offered": { status: 404, body: {} } }).send(entry)).toBe(false);
    expect(await sender({ "GET /api/phones/offered": { status: 500, body: { shareAsk: false } } }).send(entry)).toBe(false);
    expect(await sender({ "GET /api/phones/offered": "throw" }).send(entry)).toBe(false);
  });

  it("a throw on the revoke call stays queued", async () => {
    expect(await sender({ "POST /api/phones/ask-revoke": "throw" }).send(entry)).toBe(false);
  });
});

describe("createAskRevocations with a not-offered answer", () => {
  it("lets the waiter go but keeps the entry queued and keeps retrying until a real ack", async () => {
    const file = fileName();
    let calls = 0;
    const q = createAskRevocations({ file, send: async () => (++calls < 3 ? "not-offered" : true), retryMs: 15 });
    q.add({ deviceId: "devA", through: 4 });
    await q.acked("devA");
    // the first answer released the waiter, yet the entry is still owed
    expect(calls).toBeGreaterThanOrEqual(1);
    if (calls < 3) { expect(q.pending()).toEqual([{ deviceId: "devA", through: 4 }]); expect(onDisk(file)).toEqual([{ deviceId: "devA", through: 4 }]); }
    for (let i = 0; i < 100 && q.pending().length > 0; i++) await wait(15);
    expect(calls).toBe(3);
    expect(q.pending()).toEqual([]);
  });
});

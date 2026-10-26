// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Typed stop (designs/TYPED-STOP-107.md): the exact match rule (U1), the row born finished with the waiting messages marked in one
// transaction (U2), and the one caller that may ask for a typed stop (G1, F7).
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendFingerprint } from "./send-idempotency.ts";
import { sendStore } from "./send-store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { isTypedStop } from "./typed-stop.ts";

const indexSource = () => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");

describe("U1: only a plain stop is a typed stop", () => {
  it.each(["stop", "Stop", "STOP", "stop.", "Stop!", "stop!!", "  stop  ", "stop\n"])("%j stops", (text) => {
    expect(isTypedStop(text)).toBe(true);
  });
  it.each([
    "stop using tabs", "stop the build and run tests", "please stop the server and restart it", "please stop", "stop now", "Stop now!",
    "stop it please", "don't stop", "never stop", "non-stop", "stop-loss at 5%", "why did it stop?", "it stopped", "`stop`", "\"stop\"",
    "'stop'", "> stop", "stop\nthen deploy", "halt", "cancel", "abort", "pause", "stopp", "s t o p", "stop?", "", "arrête", "parar",
  ])("%j is an ordinary message", (text) => {
    expect(isTypedStop(text)).toBe(false);
  });
});

describe("U2: a typed stop's row is born finished, with the waiting messages marked, in one transaction", () => {
  const dirs: string[] = [];
  const handles: DatabaseSync[] = [];
  let file = "";
  const start = () => { const db = new DatabaseSync(file); handles.push(db); sendStore.reset(); sendStore.use(() => db); };
  beforeEach(() => { const dir = mkdtempSync(join(tmpdir(), "typed-stop-")); dirs.push(dir); file = join(dir, "messages.db"); start(); });
  afterEach(() => { sendStore.reset(); for (const h of handles.splice(0)) { try { h.close(); } catch { /* closed */ } } for (const d of dirs.splice(0)) removeTempDirSync(d); });
  const input = (text: string, sendId: string) => ({ kind: "bot" as const, ownerId: "bot-1", threadId: "t1", text, sendId, fingerprint: sendFingerprint(text) });

  it("the stop is cancelled with no words, never pending, never passed; waiting messages are marked; a restart runs neither", () => {
    const waiting = sendStore.accept({ ...input("summarize the report", "s1"), status: "queued" }).row;
    const stop = sendStore.acceptTypedStop(input("Stop!", "s2"));
    expect(stop.kind).toBe("new");
    expect(sendStore.bySeq(stop.row.seq)).toMatchObject({ status: "cancelled", mode: "typedStop", text: "", dispatched: false });
    expect(sendStore.bySeq(waiting.seq)?.stopped).toBe(true);
    expect(sendStore.pending("t1").map((row) => row.text)).toEqual(["summarize the report"]);
    expect(sendStore.hasPassed("t1", waiting.seq)).toBe(false);   // an earlier steer refused late is requeued, as after a button Stop
    start();                                                       // Murage restarts
    const { requeued } = sendStore.recover();
    expect(requeued).toEqual([]);
    expect(sendStore.pending("t1").map((row) => [row.text, row.status])).toEqual([["summarize the report", "refused"]]);
  });
  it("a retry of the same send id gets the finished row back and marks nothing new", () => {
    const first = sendStore.acceptTypedStop(input("stop", "s3"));
    const later = sendStore.accept({ ...input("typed after the stop", "s4"), status: "queued" }).row;
    const again = sendStore.acceptTypedStop(input("stop", "s3"));
    expect(again).toMatchObject({ kind: "existing", row: { seq: first.row.seq, status: "cancelled" } });
    expect(sendStore.bySeq(later.seq)?.stopped).toBe(false);
  });
});

describe("G1: only the owner's send route can ask for a typed stop (F7)", () => {
  it("every other acceptBotSend caller (the limit failover resend) passes no typedStop, and admitDirectSend never decides one", () => {
    const source = indexSource();
    const calls = [...source.matchAll(/acceptBotSend\(\{[^}]*\}/g)].map((match) => match[0]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((call) => call.includes("typedStop"))).toEqual([expect.stringContaining("typedStop: true")]);
    // the card answer, the late answer and acceptBotSend's ordinary path all reach admitDirectSend, which has no typed-stop branch
    expect([...source.matchAll(/admitDirectSend\(\{[^}]*\}/g)].filter((match) => match[0].includes("typedStop"))).toEqual([]);
  });
});

import { DatabaseSync } from "node:sqlite";
import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { fencedSubmit, fencedTurnInput } from "./engine-input.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { buildPrompt, promptPart, noneRef } from "../memory/prompt-parts.ts";
import { checkedOpenTurns } from "../memory/lineage-write.ts";
import { joinReleaseTransaction, releaseTransaction } from "../memory/release-transaction.ts";
import type { SendTurnInput } from "../contracts.ts";
import { MemorySendBusy, MemorySendCommitFailed } from "../memory/learning-send.ts";

it.each([false, true])("actual engine frame owns one writer transaction, composed learning=%s", composed => {
  const f = consumingFixture();
  f.f.db.exec("PRAGMA journal_mode=WAL");
  const other = new DatabaseSync(String(f.f.db.prepare("PRAGMA database_list").get()!.file));
  other.exec("PRAGMA busy_timeout=0");
  const competing = () => other.exec("BEGIN IMMEDIATE; COMMIT");
  const prompt = buildPrompt(f.turn, [promptPart('é\n"', [noneRef("owner-turn")])]);
  const frame = JSON.stringify({ type: "user", text: prompt.text }) + "\n";
  let frames = 0, owners = 0;
  const owner: SendTurnInput["fencedWrite"] = (write, validate) => {
    owners++;
    return releaseTransaction(f.f.db, {
      validate: context => { if (validate) joinReleaseTransaction(context, f.f.db, () => validate(context)); },
      emit: () => ({ result: write() }),
    }).result;
  };
  const input = fencedTurnInput({ threadId: "T", prompt, ...(composed ? { fencedWrite: owner } : {}) },
    { reader: checkedOpenTurns(f.turn)[0]!.reader!, db: f.f.db, retained: f.turn });
  const stream = new Writable({ write(bytes, _encoding, done) {
    expect(competing).toThrow(/busy|locked/i);
    expect(f.f.db.isTransaction).toBe(true);
    expect(bytes.toString()).toBe(frame); frames++; done();
  } });
  try {
    const before = f.budget.counts;
    input.beforeSubmit?.();
    expect(f.budget.counts.attempts).toBe(before.attempts);
    fencedSubmit(input, () => stream.write(frame), frame);
    expect(frames).toBe(1);
    expect(f.budget.counts.attempts - before.attempts).toBe(1);
    expect(f.budget.counts.bytes - before.bytes).toBe(Buffer.byteLength(frame));
    expect(owners).toBe(composed ? 1 : 0);
    expect(competing).not.toThrow();
    f.flip();
    expect(() => fencedSubmit(input, () => stream.write(frame), frame)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(frames).toBe(1);
  } finally { stream.destroy(); other.close(); f.close(); }
});

it("validation and serialization alone do not charge an emitted engine attempt", async () => {
  const f = consumingFixture();
  try {
    const wire = await import("./engine-wire.ts");
    const prompt = buildPrompt(f.turn, [promptPart("fixture", [noneRef("owner-turn")])]);
    const input = fencedTurnInput({ threadId: "T", prompt },
      { reader: checkedOpenTurns(f.turn)[0]!.reader!, db: f.f.db, retained: f.turn });
    const before = f.budget.counts;
    input.beforeSubmit?.();
    wire.engineJsonLine({ text: prompt.text }, input.beforeSubmit);
    expect(f.budget.counts.attempts).toBe(before.attempts);
    expect(f.budget.counts.bytes).toBe(before.bytes);
  } finally { f.close(); }
});

it("a caller Stop error precedes engine validation and preserves its identity", () => {
  const f = consumingFixture(), write = vi.fn(), stopped = new Error("fixture Stop");
  try {
    const prompt = buildPrompt(f.turn, [promptPart("fixture", [noneRef("owner-turn")])]);
    const input = fencedTurnInput({ threadId: "T", prompt, beforeSubmit: () => { throw stopped; } },
      { reader: checkedOpenTurns(f.turn)[0]!.reader!, db: f.f.db, retained: f.turn });
    f.flip();
    let caught: unknown;
    try { input.beforeSubmit?.(); fencedSubmit(input, write, "frame"); } catch (error) { caught = error; }
    expect(caught).toBe(stopped);
    expect(write).not.toHaveBeenCalled();
    expect(f.budget.counts.attempts).toBe(0);
  } finally { f.close(); }
});

it("the composed owner retains its busy classification before any engine release", () => {
  const f = consumingFixture(), busy = new MemorySendBusy(), write = vi.fn();
  try {
    const prompt = buildPrompt(f.turn, [promptPart("fixture", [noneRef("owner-turn")])]);
    const input = fencedTurnInput({ threadId: "T", prompt, fencedWrite: () => { throw busy; } },
      { reader: checkedOpenTurns(f.turn)[0]!.reader!, db: f.f.db, retained: f.turn });
    let caught: unknown;
    try { fencedSubmit(input, write, "frame"); } catch (error) { caught = error; }
    expect(caught).toBe(busy);
    expect(write).not.toHaveBeenCalled();
    expect(f.budget.counts.attempts).toBe(0);
    expect(f.refusals).toBe(0);
  } finally { f.close(); }
});

it("Stop is rechecked inside the owner without charging or relabeling the blocked frame", () => {
  const f = consumingFixture(), stopped = new Error("Stop under owner"), write = vi.fn();
  try {
    const prompt = buildPrompt(f.turn, [promptPart("fixture", [noneRef("owner-turn")])]);
    const input = fencedTurnInput({ threadId: "T", prompt },
      { reader: checkedOpenTurns(f.turn)[0]!.reader!, db: f.f.db, retained: f.turn });
    let caught: unknown;
    try { fencedSubmit(input, write, "frame", () => { expect(f.f.db.isTransaction).toBe(true); throw stopped; }); }
    catch (error) { caught = error; }
    expect(caught).toBe(stopped);
    expect(write).not.toHaveBeenCalled();
    expect(f.budget.counts.attempts).toBe(0);
    expect(f.refusals).toBe(0);
  } finally { f.close(); }
});

it("the composed owner's commit failure seals the retained generation after one release", () => {
  const f = consumingFixture(), write = vi.fn(), failed = new MemorySendCommitFailed();
  const member = checkedOpenTurns(f.turn)[0]!;
  try {
    const prompt = buildPrompt(f.turn, [promptPart("fixture", [noneRef("owner-turn")])]);
    const input = fencedTurnInput({ threadId: "T", prompt, fencedWrite: (emit, validate) => {
      releaseTransaction(f.f.db, { validate, emit });
      // C translates its failed COMMIT to this public learning error.
      throw failed;
    } }, { reader: checkedOpenTurns(f.turn)[0]!.reader!, db: f.f.db, retained: f.turn });
    let caught: unknown;
    try { fencedSubmit(input, write, "frame"); } catch (error) { caught = error; }
    expect(caught).toBe(failed);
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.budget.counts.attempts).toBe(1);
    expect(f.refusals).toBe(1);
    expect(member.sealed).toBe(true);
  } finally { f.close(); }
});

it("a consuming binding cannot submit a prompt without its captured writer", () => {
  const f = consumingFixture(), write = vi.fn();
  try {
    const input = { releaseBinding: f.binding } as SendTurnInput;
    expect(() => fencedSubmit(input, write, "prompt frame")).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).not.toHaveBeenCalled();
  } finally { f.close(); }
});

it.each([false, true])("a stale captured generation cannot write even while its source remains visible, composed learning=%s", composed => {
  const f = consumingFixture(), write = vi.fn();
  try {
    const prompt = buildPrompt(f.turn, [promptPart("still visible", [noneRef("owner-turn")])]);
    const input = fencedTurnInput({ threadId: "T", prompt, releaseBinding: f.binding,
      ...(composed ? { fencedWrite: <R>(emit: () => R, validate?: (context: import("../memory/release-transaction.ts").ReleaseContext) => void): R =>
        releaseTransaction(f.f.db, { validate, emit }) } : {}) },
      { reader: checkedOpenTurns(f.turn)[0]!.reader!, db: f.f.db, retained: f.turn });
    fencedSubmit(input, write, "first frame");
    expect(write).toHaveBeenCalledTimes(1);
    const before = f.budget.counts;
    f.replace();
    // Source-only admission is still green; only the original turn's binding
    // can distinguish this obsolete callback from the replacement generation.
    expect(() => input.beforeSubmit?.()).not.toThrow();
    expect(() => fencedSubmit(input, write, "stale frame")).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(write).toHaveBeenCalledTimes(1);
    expect(f.budget.counts.attempts).toBe(before.attempts);
    expect(f.budget.counts.bytes).toBe(before.bytes);
  } finally { f.close(); }
});

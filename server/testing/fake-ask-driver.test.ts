// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { makeAskDriver } from "./fake-ask-driver.ts";
import { removeTempDirSync } from "./cleanup.ts";

it.each([false, true])("a named release belongs to its held turn, with older interrupt=%s", async (interruptOlder) => {
  const dir = mkdtempSync(join(tmpdir(), "murage-ask-release-"));
  const instance = await makeAskDriver().create({ instanceId: "ask", displayName: "Ask fixture", enabled: true, config: {}, environment: { FAKE_ASK_DIR: dir } });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => events.push(event));
  vi.useFakeTimers();
  try {
    writeFileSync(join(dir, "hold"), "");
    const older = await instance.adapter.sendTurn({ threadId: "older", text: "old held turn" } as SendTurnInput);
    writeFileSync(join(dir, "hold"), "");
    const current = await instance.adapter.sendTurn({ threadId: "current", text: "current held turn" } as SendTurnInput);
    writeFileSync(join(dir, "release"), current.turnId);
    if (interruptOlder) {
      await instance.adapter.interruptTurn("older");
      expect(readFileSync(join(dir, "live"), "utf8")).toBe(current.turnId);
    }
    // The older interval runs first. It must neither take the new release
    // nor remove it while unwinding its own interrupted turn.
    await vi.advanceTimersByTimeAsync(20);
    expect(events.filter(event => event.type === "turn.completed" && event.ok).map(event => event.turnId)).toEqual([current.turnId]);
    expect(events.some(event => event.type === "turn.completed" && event.ok && event.turnId === older.turnId)).toBe(false);
  } finally {
    await instance.adapter.stopAll();
    await vi.advanceTimersByTimeAsync(20);
    vi.useRealTimers();
    await instance.dispose();
    removeTempDirSync(dir);
  }
});

it.each([false, true])("prompt ingress reports its receipt after acceptance; refused=%s", async refused => {
  const dir = mkdtempSync(join(tmpdir(), "murage-ask-receipt-"));
  const instance = await makeAskDriver().create({ instanceId: "ask", displayName: "Ask fixture", enabled: true, config: {}, environment: { FAKE_ASK_DIR: dir } });
  const receipts: string[] = [];
  const dump = join(dir, "dump.jsonl");
  try {
    expect(instance.adapter.capabilities.fencedWrites).toBe(true);
    await instance.adapter.sendTurn({ threadId: "receipt-thread", text: "fixture prompt", beforeSubmit: () => {
      expect(existsSync(dump)).toBe(false);
      receipts.push("fence");
      if (refused) throw new Error("fixture refusal");
      return 17;
    }, attemptWritten: id => {
      expect(id).toBe(17);
      expect(JSON.parse(readFileSync(dump, "utf8")).text).toBe("fixture prompt");
      receipts.push("written");
    }, attemptNotWritten: () => { expect(existsSync(dump)).toBe(false); receipts.push("not-written"); },
    attemptUncertain: () => receipts.push("uncertain"), onEngineWrite: () => receipts.push("engine-write") } as SendTurnInput);
    expect(receipts).toEqual(refused ? ["fence", "not-written"] : ["fence", "written", "engine-write"]);
    expect(existsSync(dump)).toBe(!refused);
  } finally {
    await instance.adapter.stopAll();
    await instance.dispose();
    removeTempDirSync(dir);
  }
});

it("an entered fixture write that throws remains uncertain and is never reported unwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-ask-write-fault-"));
  const instance = await makeAskDriver().create({ instanceId: "ask", displayName: "Ask fixture", enabled: true, config: {}, environment: { FAKE_ASK_DIR: dir } });
  const receipts: string[] = [];
  try {
    mkdirSync(join(dir, "dump.jsonl"));
    await instance.adapter.sendTurn({ threadId: "fault-thread", text: "fixture prompt", beforeSubmit: () => 23,
      attemptWritten: () => receipts.push("written"), attemptNotWritten: () => receipts.push("not-written"),
      attemptUncertain: id => { expect(id).toBe(23); receipts.push("uncertain"); },
      onEngineWrite: () => receipts.push("engine-write") } as SendTurnInput);
    expect(receipts).toEqual(["uncertain"]);
  } finally {
    await instance.adapter.stopAll(); await instance.dispose(); removeTempDirSync(dir);
  }
});

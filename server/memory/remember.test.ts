// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Learn about me (r3 C1): `remember` writes one active owner memory for each
// kept line, through the owner gate, and every Keep leaves a durable outcome
// row (record or duplicate-of) that a replay returns and Forget never removes.
import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { WORKSPACE_OWNER } from "../human-principals.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { runRevocationJobsNow } from "./memory-revocation.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

type Answer = { record: { id: string; version: number; text: string; state: string; assertion: string; validFrom: number; scopeId: string }; duplicate?: true };
function fixture() {
  const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
  reconcileMemoryRoster(roster); setMemoryMode("active");
  const owner = ownerMemoryTicket();
  const act = (body: Record<string, unknown>) => memoryOwnerRoute("/api/memory/action", body, owner, roster);
  const remember = (actionId: string, text: string, origin: Record<string, unknown> = { provider: "chatgpt", date: "2025-03-10" }) => act({ action: "remember", actionId, text, origin }) as Promise<Answer>;
  const registry = new InternalCapabilities(); registry.begin("bot", "thread", "generation");
  const access = (notOwnerAudience = false) => {
    const token = registry.mint({ botId: "bot", threadId: "thread", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false, ...(notOwnerAudience ? { notOwnerAudience: true as const } : {}) });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
  const count = (table: string) => Number(database().prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
  const records = () => count("memory_records");
  const forget = async (id: string) => { await act({ action: "forget", kind: "record", id }); runRevocationJobsNow(database()); };
  return { roster, owner, act, remember, access, bridge, count, records, forget };
}

describe("remember: one active owner memory per kept line (R1)", () => {
  it("writes an owner-statement fact in the owner's preferences scope, dated, with no source or evidence", async () => {
    const f = fixture();
    const before = { sources: f.count("memory_sources"), versions: f.count("memory_source_versions"), evidence: f.count("memory_evidence") };
    const { record, duplicate } = await f.remember("lam-r1-first", "I prefer short answers");
    expect(duplicate).toBeUndefined();
    expect(record).toMatchObject({ text: "I prefer short answers", state: "active", assertion: "owner-statement", version: 1 });
    expect(record.id.startsWith("owner-note:chatgpt:")).toBe(true);
    expect(record.scopeId).toBe(ensureScope("preferences", "person:" + WORKSPACE_OWNER));
    expect(record.validFrom).toBe(new Date(2025, 2, 10).getTime());
    expect({ sources: f.count("memory_sources"), versions: f.count("memory_source_versions"), evidence: f.count("memory_evidence") }).toEqual(before);
  });

  it("reaches the owner's turn and not a turn whose words are not proven to be the owner's", async () => {
    const f = fixture();
    const { record } = await f.remember("lam-r1-reach", "Call me Sam");
    await f.act({ action: "pin", id: record.id, version: 1, pinned: true });
    const owner = await buildMemoryBundle("Sam", f.access(), f.bridge, { allowance: LineageAllowance.tool() });
    expect(owner.pinned.map(item => item.text)).toContain("Call me Sam");
    const stranger = f.access(true);
    expect(stranger.scopeIds).not.toContain(record.scopeId);
    const other = await buildMemoryBundle("Sam", stranger, f.bridge, { allowance: LineageAllowance.tool() });
    expect(other.pinned.map(item => item.text)).not.toContain("Call me Sam");
  });

  it("treats a missing, bad or future date as now", async () => {
    const f = fixture(); const start = Date.now();
    const undated = await f.remember("lam-r1-undated", "Undated line", { provider: "claude" });
    const future = await f.remember("lam-r1-future", "Future line", { provider: "grok", date: "2999-01-01" });
    for (const answer of [undated, future]) expect(answer.record.validFrom).toBeGreaterThanOrEqual(start);
    await expect(f.remember("lam-r1-baddate", "Bad date", { provider: "grok", date: "10/03/2025" })).rejects.toThrow("INVALID_MEMORY_ARGUMENTS");
  });
});

describe("remember: replay, conflict and refusals (R2)", () => {
  it("returns the same answer for the same action id and writes one row", async () => {
    const f = fixture();
    const first = await f.remember("lam-r2-replay", "I live in Austin");
    const rows = f.records();
    expect(await f.remember("lam-r2-replay", "I live in Austin")).toEqual(first);
    expect(f.records()).toBe(rows);
  });

  it("refuses the same action id with other words or another provider", async () => {
    const f = fixture();
    await f.remember("lam-r2-conflict", "I live in Austin");
    await expect(f.remember("lam-r2-conflict", "I live in Boston")).rejects.toThrow("MEMORY_IDEMPOTENCY_CONFLICT");
    // the action id is the key whichever provider the line names: another provider never makes a second record
    await expect(f.remember("lam-r2-conflict", "I live in Austin", { provider: "gemini", date: "2025-03-10" })).rejects.toThrow("MEMORY_IDEMPOTENCY_CONFLICT");
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE text LIKE 'I live in%'").get()!.n)).toBe(1);
  });

  it("answers duplicate for words already kept, writing no record", async () => {
    const f = fixture();
    const first = await f.remember("lam-r2-dup-a", "I like tea");
    const rows = f.records();
    const second = await f.remember("lam-r2-dup-b", "I like tea", { provider: "claude" });
    expect(second).toEqual({ duplicate: true, record: first.record });
    expect(f.records()).toBe(rows);
  });

  it("refuses when memory is not active and when a line is only a key", async () => {
    const f = fixture();
    await expect(f.remember("lam-r2-key", ["sk", "test", "x".repeat(32)].join("-"))).rejects.toMatchObject({ status: 400 });
    setMemoryMode("capture");
    await expect(f.remember("lam-r2-mode", "Paused line")).rejects.toMatchObject({ status: 409 });
    expect(f.records()).toBe(0);
  });
});

describe("remember: the outcome row outlives Forget", () => {
  it("a replay after Forget returns the forgotten record and never writes it again (H1)", async () => {
    const f = fixture();
    const first = await f.remember("lam-h1-insert", "SENTINEL-H1 my locker code is 4412");
    await f.forget(first.record.id);
    const replay = await f.remember("lam-h1-insert", "SENTINEL-H1 my locker code is 4412");
    expect(replay.record.id).toBe(first.record.id);
    expect(replay.record.state).toBe("deleted");
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='active'").get()!.n)).toBe(0);
  });

  it("a lost duplicate answer replayed after the original is forgotten stays a duplicate (N2)", async () => {
    const f = fixture();
    const kept = await f.remember("lam-n2-a", "SENTINEL-N2 I am allergic to peanuts");
    const duplicate = await f.remember("lam-n2-b", "SENTINEL-N2 I am allergic to peanuts", { provider: "claude" });
    expect(duplicate.duplicate).toBe(true);
    // the answer to b was lost; the owner forgets a; the window retries b with the same action id
    await f.forget(kept.record.id);
    const retry = await f.remember("lam-n2-b", "SENTINEL-N2 I am allergic to peanuts", { provider: "claude" });
    expect(retry).toMatchObject({ duplicate: true, record: { id: kept.record.id, state: "deleted" } });
    expect(Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE state='active'").get()!.n)).toBe(0);
  });
});

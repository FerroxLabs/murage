// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Learn about me, Round 5 (designs/LAM-FORGET-R5.md): a kept line is forgotten by the shipped record forget, and its words are gone
// from the Forget commit on, even when the inline run stops and the job is left for the runner.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { memoryOwnerRoute } from "./settings.ts";
import { ownerMemoryTicket, readCorrectionTarget } from "./authority.ts";
import { INLINE_REVOCATION, runRevocationJobsNow } from "./memory-revocation.ts";
import { applyMemoryTombstones } from "./restore.ts";
import { forgetMemory } from "./forget.ts";
import { readableMemoryRecord } from "./readable.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { insertMemoryRecord } from "./record-write.ts";
import { ownerListHooks } from "./owner-list.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const inline = { ...INLINE_REVOCATION };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { Object.assign(INLINE_REVOCATION, inline); delete ownerListHooks.beforeForgetCheck; });

type Answer = { record: { id: string; version: number; text: string; state: string } };
function fixture() {
  const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
  reconcileMemoryRoster(roster); setMemoryMode("active");
  const owner = ownerMemoryTicket();
  const act = (body: Record<string, unknown>) => memoryOwnerRoute("/api/memory/action", body, owner, roster);
  const keep = async (text: string) => (await act({ action: "remember", actionId: `lam-${randomUUID()}`, text, origin: { provider: "chatgpt" } }) as Answer).record;
  const registry = new InternalCapabilities(); registry.begin("bot", "thread", "generation");
  const access = () => {
    const token = registry.mint({ botId: "bot", threadId: "thread", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  };
  const readable = (id: string) => { try { return typeof readableMemoryRecord(id, 1, access(), { allowance: LineageAllowance.tool() }) !== "string"; } catch { return false; } };
  const holding = (word: string) => Number(database().prepare("SELECT count(*) AS n FROM memory_records WHERE text LIKE ?").get(`%${word}%`)!.n);
  const jobRows = () => Number(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='memory-revocation'").get()!.n);
  return { act, keep, readable, holding, jobRows };
}
/** A child derived from `parent` (the way consolidation records lineage), and a correction candidate proposed against it. */
function derivedAndCorrection(parent: { id: string; version: number }) {
  const scope = String(database().prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=?").get(parent.id, parent.version)!.scope_id);
  const child = randomUUID(), candidate = randomUUID(), now = Date.now();
  transaction(db => {
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','LAMR5-CHILD derived','inferred','active',0,?,NULL,NULL,?)").run(child, scope, now, now);
    db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(parent.id, parent.version, child);
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','a newer wording','inferred','candidate',0,?,NULL,?,?)").run(candidate, scope, now, parent.id, now);
    db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(parent.id, parent.version, candidate);
  });
  return { child, candidate };
}

describe("Learn about me R5: Forget of a kept line", () => {
  it("LAM-R5-1: words gone at the commit while the job waits for the runner; derived children still end", async () => {
    const f = fixture();
    const kept = await f.keep("LAMR5-ONE my locker code is 4412");
    const { child } = derivedAndCorrection(kept);
    expect(f.readable(kept.id)).toBe(true);
    Object.assign(INLINE_REVOCATION, { rows: 0, ms: 0 });
    await f.act({ action: "forget", kind: "record", id: kept.id });
    expect(f.jobRows()).toBeGreaterThan(0);
    expect(f.holding("LAMR5-ONE")).toBe(0);
    expect(f.readable(kept.id)).toBe(false);
    const inspect = await f.act({ action: "inspect", id: kept.id, version: 1 }) as { record: { text: string } };
    expect(inspect.record.text).toBe("");
    const pinned = await f.act({ action: "pin", id: kept.id, version: 1, pinned: true }).catch(() => null) as { record?: { text: string } } | null;
    if (pinned?.record) expect(pinned.record.text).toBe("");
    Object.assign(INLINE_REVOCATION, inline);
    runRevocationJobsNow(database());
    expect(database().prepare("SELECT state,text FROM memory_records WHERE id=?").get(kept.id)).toMatchObject({ state: "deleted", text: "" });
    expect(database().prepare("SELECT state FROM memory_records WHERE id=?").get(child)?.state).toBe("deleted");
    expect(f.holding("LAMR5-CHILD")).toBe(0);
  });

  it("LAM-R5-2: a correction proposed against a forgotten line shows no target words", async () => {
    const f = fixture();
    const kept = await f.keep("LAMR5-TWO I live on Elm Street");
    const { candidate } = derivedAndCorrection(kept);
    expect(readCorrectionTarget(database(), candidate, 1)?.target?.text).toBe("LAMR5-TWO I live on Elm Street");
    Object.assign(INLINE_REVOCATION, { rows: 0, ms: 0 });
    await f.act({ action: "forget", kind: "record", id: kept.id });
    expect(readCorrectionTarget(database(), candidate, 1)).toEqual({ status: "unavailable", target: null });
  });

  it("LAM-R5-3: a file restored from before the Forget keeps no words of the forgotten line", async () => {
    const f = fixture();
    const kept = await f.keep("LAMR5-THREE restored line");
    await f.act({ action: "forget", kind: "record", id: kept.id }); runRevocationJobsNow(database());
    // the words come back from an older copy of the file; the tombstone is in the merged file
    database().prepare("UPDATE memory_records SET text='LAMR5-THREE restored line',state='active' WHERE id=?").run(kept.id);
    transaction(db => applyMemoryTombstones(db));
    expect(f.holding("LAMR5-THREE")).toBe(0);
  });

  it("LAM-R5-4: the Keep ledger holds a hash of the redacted words, not of a secret", async () => {
    const f = fixture();
    const secret = "sk-ant-api03-" + "Q".repeat(40);
    const text = `LAMR5-FOUR my work key is ${secret}`;
    const actionId = `lam-${randomUUID()}`;
    await f.act({ action: "remember", actionId, text, origin: { provider: "grok" } });
    const raw = createHash("sha256").update(JSON.stringify([text, "grok", null])).digest("hex");
    const rows = database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='remember-action'").all();
    expect(rows.length).toBe(1);
    const ledger = JSON.parse(String(rows[0]!.intent)) as { asked: string };
    expect(ledger.asked).not.toBe(raw);
    expect(String(rows[0]!.intent)).not.toContain(secret);
    // the same action again answers the first outcome
    const again = await f.act({ action: "remember", actionId, text, origin: { provider: "grok" } }) as Answer;
    expect(again.record.text).not.toContain(secret);
  });

  it("LAM-R5-5: a line corrected past 64 versions shows no words in the list, search, Inspect or a replayed Keep while the job waits", async () => {
    const f = fixture();
    const actionId = `lam-${randomUUID()}`;
    const kept = (await f.act({ action: "remember", actionId, text: "LAMR5-FIVE first wording", origin: { provider: "chatgpt" } }) as Answer).record;
    const scope = String(database().prepare("SELECT scope_id FROM memory_records WHERE id=? AND version=1").get(kept.id)!.scope_id);
    transaction(db => {
      db.prepare("UPDATE memory_records SET state='superseded' WHERE id=? AND version=1").run(kept.id);
      for (let version = 2; version <= 65; version++) insertMemoryRecord(db, { id: kept.id, version, scopeId: scope, kind: "fact", text: `LAMR5-FIVE wording ${version}`, assertion: "owner-statement", state: version === 65 ? "active" : "superseded", validFrom: Date.now(), createdAt: Date.now() + version });
    });
    type Page = { records: Array<{ id: string; version: number; text: string }>; nextCursor?: string };
    /** Every page of the owner list (and of a search when `query` is given): the rows of the kept line. */
    const shown = async (query?: string) => {
      const rows: Page["records"] = []; let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const answer = await f.act({ action: "list", ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) }) as Page;
        rows.push(...answer.records.filter(row => row.id === kept.id));
        if (!answer.nextCursor) break; cursor = answer.nextCursor;
      }
      return rows;
    };
    const before = await shown();
    expect(before.some(row => row.version === 1 && row.text.includes("LAMR5-FIVE"))).toBe(true);
    Object.assign(INLINE_REVOCATION, { rows: 0, ms: 0 });
    await f.act({ action: "forget", kind: "record", id: kept.id });
    expect(f.jobRows()).toBeGreaterThan(0);
    // the newest 64 versions are blank at the commit; version 1 keeps its words until the expand phase
    expect(f.holding("LAMR5-FIVE first")).toBe(1);
    expect(await shown()).toEqual([]);
    expect(await shown("LAMR5-FIVE")).toEqual([]);
    for (const version of [1, 65]) {
      const inspect = await f.act({ action: "inspect", id: kept.id, version }) as { record: { text: string }; evidence: unknown[] };
      expect(inspect.record.text).toBe("");
      expect(inspect.evidence).toEqual([]);
    }
    // the same Keep again answers the first outcome, version 1, with no words
    const replay = await f.act({ action: "remember", actionId, text: "LAMR5-FIVE first wording", origin: { provider: "chatgpt" } }) as Answer;
    expect(replay.record).toMatchObject({ id: kept.id, version: 1, text: "" });
    Object.assign(INLINE_REVOCATION, inline);
    runRevocationJobsNow(database());
    expect(f.holding("LAMR5-FIVE")).toBe(0);
  });

  it("LAM-R5-6: a Forget that commits while the list is reading is reflected in what the list returns", async () => {
    const f = fixture();
    const kept = await f.keep("LAMR5-SIX my gate code is 7731");
    Object.assign(INLINE_REVOCATION, { rows: 0, ms: 0 });
    let forgot = false;
    ownerListHooks.beforeForgetCheck = () => {
      // the rows were read before this runs; the Forget commits now, before the list returns
      expect(f.holding("LAMR5-SIX")).toBe(1);
      forgetMemory(ownerMemoryTicket(), { kind: "record", id: kept.id });
      forgot = true;
    };
    const answer = await f.act({ action: "list" }) as { records: Array<{ id: string; text: string }> };
    expect(forgot).toBe(true);
    expect(answer.records.filter(row => row.id === kept.id)).toEqual([]);
    expect(JSON.stringify(answer.records)).not.toContain("LAMR5-SIX");
  });
});

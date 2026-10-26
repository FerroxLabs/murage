// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// XTHREAD-JUDGE (1.0.4, OPEN-104 High, privacy): recall judges every evidence line of a record with the reader's audience, whatever its
// thread. A channel person's reply in one conversation was withheld from that person after a roster or settings change revoked its
// receipt, yet a record extracted from it afterwards came back in the person's other conversation, because the reader's rule judged only
// lines of the reader's own thread. T1, T2, T3, T4, T6 and T7 of the design; T5 (cost) is xthread-judge-bounds.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { database, transaction } from "../database.ts";
import { bindHumanThread } from "../human-principals.ts";
import { assertMemoryBundle, buildMemoryBundle } from "./bundle.ts";
import { searchMemory, setAuthorizeSliceMsForTest } from "./search.ts";
import { memoryAgentRoute } from "./routes.ts";
import { filterMemoryReplay, lineageReaderOf, readerWithheldMessage } from "./disclosures.ts";
import { capturedMessageWithheld, messageCopy } from "./replay-lineage.ts";
import { denyLookup, denyReadMeter } from "./deny-read.ts";
import { readableMemoryRecord } from "./readable.ts";
import { setIntegrityFlags } from "./integrity-flags.ts";
import { FOOTPRINT_STAR } from "./lineage-types.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import type { MemoryAccess } from "./policy.ts";
import { access, append, exchange, flipReceipt, groupGuest, hits, person, QUERY, recordFrom, replyUnderReceipt, resetWorld, runJobs, world } from "./testing/xthread-world.ts";

const big = () => LineageAllowance.tool(1_000_000_000);
const lineVerdict = (thread: string, id: string, reader: ReturnType<typeof lineageReaderOf>) => denyLookup(database(), { threadId: thread, lines: [{ messageId: id, author: "generated" }] }, reader).get(id)!;
const setCopy = (thread: string, id: string, copy: { threadId: string; messageIds: string[] }) =>
  database().prepare("UPDATE messages SET json=json_set(json,'$.copyOf',json(?)) WHERE thread_id=? AND id=?").run(JSON.stringify(copy), thread, id);
const meta = () => database().prepare("SELECT data_revision,policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get();
const lookups = (run: () => unknown): number => { const before = denyReadMeter().statements; run(); return denyReadMeter().statements - before; };
const sender = (who: ReturnType<typeof world>["person"]) => access("finch", "t2", { human: who, notOwnerAudience: true });
const ids = (list: ReadonlyArray<{ id: string }>) => list.map(hit => hit.id);

afterEach(() => { try { setIntegrityFlags(database(), { hold: null, pending: false }); } catch { /* closed */ } setAuthorizeSliceMsForTest(8); });

describe("T1: a record extracted after the flip does not cross to the person's other conversation", () => {
  it("bundle, search, memory_search and memory_get from t2 leave X' out; the content judge and the owner still show it", async () => {
    const { person: who, x } = world({ flipFirst: true });
    const reader = sender(who);
    const owner = access("finch", "finch-direct");
    // positive controls: the content judge shows G1, the reader's audience withholds it, X' is in the reader's scopes, the owner reads it
    expect(capturedMessageWithheld(big(), "t1", "g1")).toBe(false);
    expect(lineVerdict("t1", "g1", lineageReaderOf(reader)).state).toBe("withheld");
    // (null: the scope and content checks alone; left out, the read takes the reader's rule, reader-rule-default.test.ts)
    expect(typeof readableMemoryRecord(x.id, x.version, reader, { allowance: big(), mode: "current", withheldMessage: null })).toBe("object");
    expect((await buildMemoryBundle(QUERY, owner, hits([x]), { allowance: LineageAllowance.tool() })).text).toContain("GATE-7731");
    // the reader's recall, through every path
    const rule = readerWithheldMessage(reader);
    expect(rule).toBeDefined();
    expect((await buildMemoryBundle(QUERY, reader, hits([x]), { allowance: LineageAllowance.tool(), withheldMessage: rule })).text).not.toContain("GATE-7731");
    expect(ids((await searchMemory(QUERY, reader, hits([x]), { allowance: LineageAllowance.tool(), withheldMessage: readerWithheldMessage(reader) })).hits)).not.toContain(x.id);
    expect(ids((await memoryAgentRoute("/api/internal/memory/search", { query: QUERY }, reader, hits([x])) as { hits: Array<{ id: string }> }).hits)).not.toContain(x.id);
    await expect(memoryAgentRoute("/api/internal/memory/get", { handles: [{ id: x.id, version: x.version }] }, reader, hits([]))).rejects.toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
  });

  it("propose-correction (routes.ts) applies the reader's rule to its target: X' is not a target for that reader", async () => {
    const { person: who, x } = world({ flipFirst: true });
    const reader = sender(who);
    const words = "the code is now GATE-9000";
    append("t2", person("a2", words));
    const body = { id: x.id, version: x.version, replacement: "The side gate code is GATE-9000.", evidence: [{ sourceId: "message:t2:a2", revision: 1, startByte: 0, endByte: Buffer.byteLength(words) }], idempotencyKey: "xt-correct" };
    await expect(memoryAgentRoute("/api/internal/memory/propose-correction", body, reader, hits([]))).rejects.toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
  });
});

describe("T2: the owner is unchanged", () => {
  it("owner direct chat, owner room turn, memory_search, memory_get and dispatch revalidation keep X'", async () => {
    const { x } = world({ flipFirst: true });
    for (const thread of ["finch-direct", "crew-chat"]) {
      const owner = access("finch", thread);
      expect(readerWithheldMessage(owner)).toBeUndefined();
      // index.ts passes owners a heldReplay closure: it does not change their search stamp or their rule
      const bundle = await buildMemoryBundle(QUERY, owner, hits([x]), { allowance: LineageAllowance.tool(), withheldMessage: () => false });
      expect(bundle.text).toContain("GATE-7731");
      expect(bundle.text).toBe((await buildMemoryBundle(QUERY, owner, hits([x]), { allowance: LineageAllowance.tool() })).text);
      expect(() => assertMemoryBundle(bundle, owner)).not.toThrow();
      expect(ids((await memoryAgentRoute("/api/internal/memory/search", { query: QUERY }, owner, hits([x])) as { hits: Array<{ id: string }> }).hits)).toContain(x.id);
      const got = await memoryAgentRoute("/api/internal/memory/get", { handles: [{ id: x.id, version: x.version }] }, owner, hits([])) as { records: Array<{ text: string }> };
      expect(got.records[0]!.text).toContain("GATE-7731");
    }
  });
});

describe("T3: fail closed for a reader that is not the owner", () => {
  let rule: NonNullable<ReturnType<typeof readerWithheldMessage>>;
  let reader: MemoryAccess;
  beforeEach(() => {
    const { person: who } = world({ flipFirst: true });
    reader = sender(who);
    rule = readerWithheldMessage(reader)!;
    exchange("t3", "shown");
    for (let n = 0; n < 17; n++) exchange("orig", `o${n}`);
  });

  it("control: a shown line of another thread is shown", () => {
    expect(rule("t3", "shown", big())).toBe(false);
    expect(rule("orig", "o0", big())).toBe(false);
  });
  it("a line in a thread with no number, and a generated line with no lineage row", () => {
    database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t-nonum','m1',1,'bot','text','x',json_object('id','m1','role','bot','kind','text','text','x','at',1))").run();
    database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t3','m2',1,'bot','text','x',json_object('id','m2','role','bot','kind','text','text','x','at',1))").run();
    expect(rule("t-nonum", "m1", big())).toBe(true);
    expect(rule("t3", "m2", big())).toBe(true);
  });
  it("a deleted (denied) thread, and a line that is not stored", () => {
    exchange("t-gone", "m3");
    expect(rule("t-gone", "m3", big())).toBe(false);
    database().prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','t-gone',1,1)").run();
    expect(rule("t-gone", "m3", big())).toBe(true);
    expect(rule("t3", "never-written", big())).toBe(true);
  });
  it("a copy of a withheld line is withheld though the copy itself reads shown", () => {
    exchange("t3", "c1");
    setCopy("t3", "c1", { threadId: "t1", messageIds: ["g1"] });
    expect(messageCopy("t3", "c1")).toEqual({ threadId: "t1", messageIds: ["g1"] });
    expect(lineVerdict("t3", "c1", lineageReaderOf(reader)).state).toBe("shown");
    expect(rule("t3", "c1", big())).toBe(true);
  });
  it("a copy of 16 shown originals is judged; of 17 it is withheld", () => {
    exchange("t3", "c16"); exchange("t3", "c17");
    setCopy("t3", "c16", { threadId: "orig", messageIds: Array.from({ length: 16 }, (_, n) => `o${n}`) });
    setCopy("t3", "c17", { threadId: "orig", messageIds: Array.from({ length: 17 }, (_, n) => `o${n}`) });
    expect(rule("t3", "c16", big())).toBe(false);
    expect(rule("t3", "c17", big())).toBe(true);
  });
  it("memory not trusted for replay (held, and the pass still pending): every cross-thread line withheld, cached or not", () => {
    expect(rule("t3", "shown", big())).toBe(false); // now kept as shown
    setIntegrityFlags(database(), { hold: "TEST_HOLD" });
    expect(rule("t3", "shown", big())).toBe(true);
    setIntegrityFlags(database(), { hold: null, pending: true });
    expect(rule("t3", "shown", big())).toBe(true);
    setIntegrityFlags(database(), { pending: false });
    expect(rule("t3", "shown", big())).toBe(false);
  });
  it("a file with no line row yet withholds every cross-thread line", () => {
    resetWorld();
    database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('tx','gx',1,'bot','text','x',json_object('id','gx','role','bot','kind','text','text','x','at',1))").run();
    expect(database().prepare("SELECT count(*) AS n FROM memory_line_lineage").get()).toEqual({ n: 0 });
    const fresh = readerWithheldMessage(access("dax", "dax-helper", { notOwnerAudience: true }))!;
    expect(fresh("tx", "gx", big())).toBe(true);
  });
});

describe("T4: every reader that is not the owner, and own-thread verdicts unchanged", () => {
  it("person, channel sender, the person's room, a group guest and a hand-off all leave X' out; the owner keeps it", async () => {
    const { person: who, x } = world({ flipFirst: true });
    const guest = groupGuest();
    bindHumanThread("finch-group", guest);
    const readers: Array<[string, MemoryAccess, boolean]> = [
      ["person", access("finch", "t2", { human: who }), true],
      ["channel sender", sender(who), true],
      // the fixture's share to the person is of the conversation scope t1, which a person's grant never reaches since 1.0.4 gap D
      // (policy.ts: only room, project, team and workspace scopes): the person's room holds no scope of X' and is refused it below
      ["room", access("finch", "lobby-chat", { human: who }), false],
      ["group guest", access("finch", "finch-group", { human: guest, notOwnerAudience: true }), false],
      ["hand-off", access("dax", "dax-helper", { notOwnerAudience: true }), false],
    ];
    for (const [name, reader, inScope] of readers) {
      const rule = readerWithheldMessage(reader);
      expect(rule, name).toBeDefined();
      expect(rule!("t1", "g1", big()), name).toBe(true);
      // where X' is in the reader's scopes it is readable on content alone: the rule is what leaves it out
      // out of scope it was never readable (nothing more to prove here); in scope it is readable on content alone, and the rule is what
      // leaves it out of every recall path
      if (!inScope) { expect(() => readableMemoryRecord(x.id, x.version, reader, { allowance: big(), mode: "current", withheldMessage: null }), name).toThrow("MEMORY_SCOPE_DENIED"); continue; }
      expect(typeof readableMemoryRecord(x.id, x.version, reader, { allowance: big(), mode: "current", withheldMessage: null }), name).toBe("object");
      expect((await buildMemoryBundle(QUERY, reader, hits([x]), { allowance: LineageAllowance.tool(), withheldMessage: rule })).text, name).not.toContain("GATE-7731");
      expect(ids((await memoryAgentRoute("/api/internal/memory/search", { query: QUERY }, reader, hits([x])) as { hits: Array<{ id: string }> }).hits), name).not.toContain(x.id);
      await expect(memoryAgentRoute("/api/internal/memory/get", { handles: [{ id: x.id, version: x.version }] }, reader, hits([])), name).rejects.toThrow();
    }
    const owner = access("finch", "finch-direct");
    expect((await buildMemoryBundle(QUERY, owner, hits([x]), { allowance: LineageAllowance.tool() })).text).toContain("GATE-7731");
  });

  it("own-thread verdicts are the transcript's own (filterMemoryReplay): none newly shown, none newly withheld", () => {
    const { person: who } = world({ flipFirst: true });
    replyUnderReceipt("t2", "a2", "g2", "The van is parked in bay 4.", "K2");
    flipReceipt("K2");
    exchange("t2", "g2b");
    const reader = sender(who);
    const rule = readerWithheldMessage(reader)!;
    const verdicts = ["a2", "g2", "g2b"].map(id => {
      const transcript = filterMemoryReplay(big(), "t2", [{ id }], reader, { persist: false, failClosed: true }).length === 0;
      expect(rule("t2", id, big()), id).toBe(transcript);
      return transcript;
    });
    expect(verdicts).toContain(true); // the revoked receipt's reply is withheld in its own thread
    expect(verdicts[0]).toBe(false);  // the person's own words are not
  });
});

describe("T6: a kept verdict does not outlive a change", () => {
  it("a flip commit (deny generation moves, no data, policy or epoch change) withholds a line kept as shown; dispatch refuses the bundle", async () => {
    const { person: who, x } = world({ flipFirst: false });
    const reader = sender(who);
    const rule = readerWithheldMessage(reader)!;
    expect(rule("t1", "g1", big())).toBe(false);
    expect(lookups(() => expect(rule("t1", "g1", big())).toBe(false))).toBe(0); // kept
    const bundle = await buildMemoryBundle(QUERY, reader, hits([x]), { allowance: LineageAllowance.tool(), withheldMessage: rule });
    expect(bundle.text).toContain("GATE-7731");
    const before = meta(), generation = database().prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='deny_generation'").get();
    flipReceipt("K");
    expect(meta()).toEqual(before);
    expect(database().prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='deny_generation'").get()).not.toEqual(generation);
    expect(rule("t1", "g1", big())).toBe(true);
    expect(() => assertMemoryBundle(bundle, reader)).toThrow("MEMORY_CONTEXT_REVOKED");
  });

  it("a same-connection rewrite of the line's footprint is judged again", () => {
    const { person: who } = world({ flipFirst: false });
    const rule = readerWithheldMessage(sender(who))!;
    expect(rule("t1", "g1", big())).toBe(false);
    const changed = database().prepare("UPDATE memory_line_lineage SET footprint=? WHERE message_id='g1' AND thread_no=(SELECT no FROM memory_thread_no WHERE thread_id='t1')").run(FOOTPRINT_STAR);
    expect(changed.changes).toBe(1);
    expect(rule("t1", "g1", big())).toBe(true);
  });

  it("inside a transaction nothing is kept", () => {
    const { person: who } = world({ flipFirst: false });
    const rule = readerWithheldMessage(sender(who))!;
    transaction(() => {
      expect(rule("t1", "g1", big())).toBe(false);
      expect(lookups(() => expect(rule("t1", "g1", big())).toBe(false))).toBeGreaterThan(0);
    });
    expect(rule("t1", "g1", big())).toBe(false);
    expect(lookups(() => rule("t1", "g1", big()))).toBe(0);
  });
});

/** Runs `search` with `flips[n]` applied just before the (n+2)th search stamp is read (the first is taken when a record is accepted, the
 * later ones by revalidate, after the loop was released): a change committed while the search is in flight. `deadline`: the hydration
 * limit has passed by the first revalidation. Returns the ids answered and how many stamps were read. */
async function midFlight<T>(search: () => Promise<T>, flips: ReadonlyArray<() => void>, deadline = false): Promise<{ result: T; stamps: number }> {
  const db = database(), prepare = db.prepare.bind(db), originalNow = performance.now.bind(performance);
  let stamps = 0, skew = 0;
  db.prepare = ((sql: string) => {
    if (sql.includes("SELECT data_revision,policy_revision,deletion_epoch FROM memory_meta WHERE id=1")) {
      stamps++;
      if (stamps >= 2) { flips[stamps - 2]?.(); if (deadline) skew = 600_000; }
    }
    return prepare(sql);
  }) as typeof db.prepare;
  (performance as { now: () => number }).now = () => originalNow() + skew;
  try { return { result: await search(), stamps }; }
  finally { db.prepare = prepare as typeof db.prepare; (performance as { now: () => number }).now = originalNow; }
}

describe("T7: a search in flight when a flip commits", () => {
  it("the reader's search reads its accepted records again and drops X'; the owner's search keeps it", async () => {
    const { person: who, x, ownWords } = world({ flipFirst: false });
    const reader = sender(who);
    const flip = () => flipReceipt("K");
    const theirs = await midFlight(() => searchMemory(QUERY, reader, hits([x, ownWords]), { allowance: LineageAllowance.tool(), withheldMessage: readerWithheldMessage(reader) }), [flip]);
    expect(theirs.stamps).toBeGreaterThanOrEqual(3);
    expect(ids(theirs.result.hits)).not.toContain(x.id);
    expect(ids(theirs.result.hits)).toContain(ownWords.id);

    const again = world({ flipFirst: false });
    const owner = access("finch", "finch-direct");
    const mine = await midFlight(() => searchMemory(QUERY, owner, hits([again.x]), { allowance: LineageAllowance.tool(), withheldMessage: () => false }), [() => flipReceipt("K")]);
    expect(mine.stamps).toBe(2);
    expect(ids(mine.result.hits)).toContain(again.x.id);
  });

  it("two receipt flips in successive rounds: each round reads again, the answer stands inside the round cap", async () => {
    const two = () => {
      const w = world({ flipFirst: false });
      // in the person's third conversation, so the first flip does not reach it: each flip withholds its own reply
      replyUnderReceipt("t3", "a3", "g3", "The back door code is DOOR-4410.", "K3");
      runJobs();
      return { ...w, x3: recordFrom("t3", "g3") };
    };
    const { person: who, x, x3, ownWords } = two();
    const reader = sender(who);
    const theirs = await midFlight(() => searchMemory(QUERY, reader, hits([x, x3, ownWords]), { allowance: LineageAllowance.tool(), withheldMessage: readerWithheldMessage(reader) }), [() => flipReceipt("K"), () => flipReceipt("K3")]);
    expect(theirs.stamps).toBe(4); // accept, moved, moved, still: two rounds read again, under REVALIDATION_ROUNDS
    expect(ids(theirs.result.hits)).toContain(ownWords.id);
    expect(ids(theirs.result.hits)).not.toContain(x.id);
    expect(ids(theirs.result.hits)).not.toContain(x3.id);

    const again = two();
    const owner = access("finch", "finch-direct");
    const mine = await midFlight(() => searchMemory(QUERY, owner, hits([again.x, again.x3]), { allowance: LineageAllowance.tool(), withheldMessage: () => false }), [() => flipReceipt("K"), () => flipReceipt("K3")]);
    expect(mine.stamps).toBe(2);
    expect(ids(mine.result.hits)).toEqual(expect.arrayContaining([again.x.id, again.x3.id]));
  });

  it("a marker that commits at every round: the reader's search reaches the round cap and answers nothing; the owner's is unaffected", async () => {
    const bump = () => database().prepare("UPDATE memory_lineage_lsn_meta SET value=value+1 WHERE key='deny_generation'").run();
    const { person: who, x } = world({ flipFirst: false });
    const reader = sender(who);
    const theirs = await midFlight(() => searchMemory(QUERY, reader, hits([x]), { allowance: LineageAllowance.tool(), withheldMessage: readerWithheldMessage(reader) }), Array.from({ length: 10 }, () => bump));
    expect(theirs.result.hits).toEqual([]);
    expect(theirs.result.partial).toBe(true);
    const owner = access("finch", "finch-direct");
    const mine = await midFlight(() => searchMemory(QUERY, owner, hits([x]), { allowance: LineageAllowance.tool(), withheldMessage: () => false }), Array.from({ length: 10 }, () => bump));
    expect(ids(mine.result.hits)).toContain(x.id);
  });

  it("a deny generation that cannot be read counts as moved, as in the reader rule: the reader's search never settles on a stamp and fails closed", async () => {
    const { person: who, x, ownWords } = world({ flipFirst: false });
    const reader = sender(who);
    database().prepare("DELETE FROM memory_lineage_lsn_meta WHERE key='deny_generation'").run();
    const theirs = await midFlight(() => searchMemory(QUERY, reader, hits([x, ownWords]), { allowance: LineageAllowance.tool(), withheldMessage: readerWithheldMessage(reader) }), []);
    expect(theirs.result.hits).toEqual([]);
    expect(theirs.result.partial).toBe(true);
    const owner = access("finch", "finch-direct");
    const mine = await midFlight(() => searchMemory(QUERY, owner, hits([x]), { allowance: LineageAllowance.tool(), withheldMessage: () => false }), []);
    expect(ids(mine.result.hits)).toContain(x.id);
  });

  it("deadline (T2): a receipt-only revoke during the search and the hydration limit passing: the owner keeps X through memory_search and the bundle, the reader drops it", async () => {
    let w = world({ flipFirst: false });
    const owner = () => access("finch", "finch-direct");
    const viaRoute = await midFlight(() => memoryAgentRoute("/api/internal/memory/search", { query: QUERY }, owner(), hits([w.x])) as Promise<{ hits: Array<{ id: string }> }>, [() => flipReceipt("K")], true);
    expect(ids(viaRoute.result.hits)).toContain(w.x.id);
    w = world({ flipFirst: false });
    const viaBundle = await midFlight(() => buildMemoryBundle(QUERY, owner(), hits([w.x]), { allowance: LineageAllowance.tool(), withheldMessage: () => false }), [() => flipReceipt("K")], true);
    expect(viaBundle.result.text).toContain("GATE-7731");
    w = world({ flipFirst: false });
    const reader = sender(w.person);
    const theirs = await midFlight(() => memoryAgentRoute("/api/internal/memory/search", { query: QUERY }, reader, hits([w.x])) as Promise<{ hits: Array<{ id: string }> }>, [() => flipReceipt("K")], true);
    expect(ids(theirs.result.hits)).not.toContain(w.x.id);
  });
});

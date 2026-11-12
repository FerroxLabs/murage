// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WritetimeFixture, CONTENT, MEMBER } from "./testing/writetime-fixture.ts";
import { denyLookup, refsLookup, denyReadMeter, resetDenyReadMeter } from "./deny-read.ts";
import * as readers from "./deny-read.ts";
import * as fence from "./send-fence.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { commitRevoke } from "./revoke-commit.ts";
import type { LineageRef, LineageReader } from "./lineage-types.ts";
// A missing implementation fails every behavioral case independently on the base tip.
const modulePath = "./settle-target.ts";
const target = await import(/* @vite-ignore */ modulePath).catch(() => ({})) as typeof import("./settle-target.ts");
const fixtures: WritetimeFixture[] = [];
beforeEach(() => { vi.spyOn(performance, "now").mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); fence.setSendFenceDeps({ db: null, classify: null }); for (const f of fixtures.splice(0)) f.close(); });
function make() {
  const f = new WritetimeFixture().cert(true).reply("T", "g", 10, { turnLsn: 1 }); fixtures.push(f);
  // Optional production indexes are installed by their existing schema worker. A fixture builds only these two.
  for (const sql of Object.values(target.settleIndexSql ?? {})) f.db.exec(sql as string);
  return f;
}
function job(f: WritetimeFixture, id = 1, thread = "T", since = 1) {
  f.job(id, 20).pending(thread, since, id);
  f.db.prepare("UPDATE memory_revoke_jobs SET root=? WHERE revoke_id=?").run(JSON.stringify({ kind: "line", threadId: "T", lines: 1, cause: "forget" }), id);
  return f;
}
const prefix = (extra = {}): LineageRef => ({ kind: "prefix", threadId: "T", headLsn: 10, shown: ["g"], ...extra });
const built = (refs: readonly LineageRef[] = [prefix()]) => buildPrompt(undefined, [promptPart("fixture", refs)]);
const classify = (f: WritetimeFixture, refs: readonly LineageRef[] = [prefix()], reader: LineageReader = CONTENT) => target.classifyDirectSettle(f.db, built(refs), reader, { threadId: "T" });
const outside = (why: string) => ({ kind: "outside", why });
const incomplete = (why: string) => ({ kind: "incomplete", why });
const own = { kind: "own", threadId: "T", headLsn: 10, targets: [1] };

describe("T2a bounded content verdict parity", () => {
  it("null bring-in sources preserve the missing-origin tombstone verdict", () => {
    const f = make().source("message:T:g", "s-room", { kind: "bring-in" });
    f.db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='message:T:g'")
      .run(JSON.stringify({ broughtFrom: { sources: null } }));
    const expected = refsLookup(f.db, [{ kind: "line", threadId: "T", messageId: "g" }], CONTENT);
    expect(expected).toEqual({ state: "withheld", reason: "tombstone" });
    expect(readers.ownLineVerdicts(f.db, "T", ["g"], CONTENT, 10).verdicts.get("g")).toEqual(expected);
  });
  it.each([false, true])("null bring-in sources refuse classification with pending=%s", pending => {
    const f = make().source("message:T:g", "s-room", { kind: "bring-in" });
    if (pending) job(f);
    f.db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='message:T:g'")
      .run(JSON.stringify({ broughtFrom: { sources: null } }));
    expect(classify(f)).toEqual(outside("withheld"));
  });
  it.each([{}, { broughtFrom: {} }, { broughtFrom: { sources: [] } }])("absent or empty origins retain clearance: %j", payload => {
    const f = make().source("message:T:g", "s-room", { kind: "bring-in" });
    f.db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='message:T:g'").run(JSON.stringify(payload));
    expect(readers.ownLineVerdicts(f.db, "T", ["g"], CONTENT, 10).verdicts.get("g"))
      .toEqual(refsLookup(f.db, [{ kind: "line", threadId: "T", messageId: "g" }], CONTENT));
    expect(classify(f)).toEqual({ kind: "clear" });
  });
  const cases: Array<[string, (f: WritetimeFixture) => void]> = [
    ["shown", () => {}], ["pending", f => { job(f); }], ["wildcard pending", f => { job(f, 1, "*"); }],
    ["post-commit turn", f => { job(f); f.db.exec("UPDATE memory_line_lineage SET turn_lsn=20"); }],
    ["post-commit inherit", f => { job(f, 1, "T", 25); f.reply("T", "late", 25); }],
    ["own flag", f => { f.message("T", "g", "bot", { withheldFromBots: true }); }],
    ["old checking flag", f => { f.message("T", "g", "bot", { withheldFromBots: "checking" }); }],
    ["missing message", f => { f.db.exec("DELETE FROM messages"); }],
    ["forgotten source", f => { f.source("message:T:g", "s-room", { state: "deleted" }); }],
    ["scope denied", f => { f.source("message:T:g", "s-room").deny("scope", "s-room"); }],
    ["source tombstone", f => { f.tombstone("source", "message:T:g", 1); }],
    ["thread deny", f => { f.deny("thread", "T"); }], ["not ready", f => { f.ready("T", false); }],
    ["no certificate", f => { f.cert(false); }], ["no lineage", f => { f.db.exec("DELETE FROM memory_line_lineage"); }],
    ["line mark", f => { f.denyLine("T", 10); }], ["range", f => { f.denyRange("T", 1, 20); }],
    ["range cap", f => { f.denyRange("T", 1, 1); }],
    ["audience marks", f => { f.denyLine("T", 10).denyRange("T", 1, 20).pending("T", 1); f.db.exec("INSERT INTO memory_revoke_audience VALUES(1)"); }],
    ["human never waits", f => { f.owner("T", "human", 12); job(f); f.ready("T", false); }],
    ["range overflow", f => { for (let i = 0; i < 257; i++) f.denyRange("T", -300 + i, 0, i); }],
  ];
  it.each(cases)("%s", (_name, setup) => {
    const f = make(); setup(f);
    const ids = ["g", ...(f.db.prepare("SELECT 1 FROM messages WHERE id='human'").get() ? ["human"] : []), ...(f.db.prepare("SELECT 1 FROM messages WHERE id='late'").get() ? ["late"] : [])];
    const got = readers.ownLineVerdicts(f.db, "T", ids, CONTENT, 10);
    for (const id of ids) expect(got.verdicts.get(id)).toEqual(refsLookup(f.db, [{ kind: "line", threadId: "T", messageId: id }], CONTENT));
    expect(got.prefix).toEqual(refsLookup(f.db, [prefix({ shown: [] })], CONTENT));
  });
  it.each(["clear", "missing", "deleted", "tombstone", "scope"])("bring-in origin %s parity", mode => {
    const f = make().source("message:T:g", "s-room", { kind: "bring-in" });
    if (mode !== "missing") f.source("origin", "s-other", { state: mode === "deleted" ? "deleted" : "active" });
    if (mode === "tombstone") f.tombstone("source", "origin", 1);
    if (mode === "scope") f.deny("scope", "s-other");
    f.db.prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='message:T:g'").run(JSON.stringify({ broughtFrom: { sources: [{ id: "origin", revision: 1 }] } }));
    expect(readers.ownLineVerdicts(f.db, "T", ["g"], CONTENT, 10).verdicts.get("g")).toEqual(refsLookup(f.db, [{ kind: "line", threadId: "T", messageId: "g" }], CONTENT));
  });
  it("preserves the content reader's ownFlag override", () => {
    const f = make().message("T", "g", "bot", { withheldFromBots: true });
    const reader = { audience: null, ownFlag: false };
    expect(readers.ownLineVerdicts(f.db, "T", ["g"], reader, 10).verdicts).toEqual(denyLookup(f.db, { threadId: "T", lines: [{ messageId: "g", author: "generated" }] }, reader));
  });
});

describe("T2b C rows and raw limits", () => {
  it.each(["forget", "hide", "edit", "delete", "branch-switch", "regenerate"] as const)("C12 accepts the production compact line root for %s", cause => {
    const f = make().owner("U", "old", 1);
    f.db.exec("BEGIN");
    const id = commitRevoke(f.db, { kind: "line", threadId: "U", messageIds: ["old"], cause }, { inline: false });
    f.db.exec("COMMIT");
    expect(target.validateSettleJob(f.db, id)).toBeNull();
    expect(classify(f)).toEqual({ kind: "flows", threadId: "T", headLsn: 10, targets: [], flowIds: [id] });
    expect(target.oldestSettleFlow(f.db)).toEqual({ revokeId: id, refusal: null });
  });
  it.each([undefined, null, -1, 1.5, "1", true, Number.MAX_SAFE_INTEGER + 1])("C12 rejects malformed compact line count %s even with messageIds", lines => {
    const f = job(make());
    f.db.prepare("UPDATE memory_revoke_jobs SET root=?").run(JSON.stringify({ kind: "line", threadId: "T", lines, messageIds: ["old"], cause: "forget" }));
    expect(classify(f)).toEqual(incomplete("job"));
  });
  it("C1 audience reader", () => expect(classify(job(make()), undefined, MEMBER)).toEqual(outside("audience-reader")));
  it("C2 257 refs", () => expect(classify(make(), [prefix(), ...Array.from({ length: 256 }, () => ({ kind: "none", reason: "static" } as const))])).toEqual(incomplete("refs")));
  it("C2 257 parts", () => {
    const f = make(); const p = buildPrompt(undefined, Array.from({ length: 257 }, () => promptPart("", [prefix()])));
    expect(target.classifyDirectSettle(f.db, p, CONTENT, { threadId: "T" })).toEqual(incomplete("refs"));
  });
  it("C3 two prefixes", () => expect(classify(make(), [prefix(), prefix()])).toEqual(outside("multi-prefix")));
  it("C3 no prefix", () => expect(classify(make(), [])).toEqual(outside("multi-prefix")));
  it.each([undefined, -1, 1.5, NaN])("C3 malformed head %s", headLsn => expect(classify(make(), [prefix({ headLsn })])).toEqual(outside("no-head")));
  it("C4 another thread line", () => expect(classify(make(), [prefix(), { kind: "line", threadId: "U", messageId: "u" }])).toEqual(outside("multi-thread")));
  it("C4 foreign prefix", () => expect(classify(make(), [prefix({ threadId: "U" })])).toEqual(outside("multi-thread")));
  it.each([600, 513])("C5 raw shown IDs %s including duplicates", n => expect(classify(make(), [prefix({ shown: Array(n).fill("g") })])).toEqual(incomplete("ids")));
  it("C5 line refs consume the same raw ID budget", () => expect(classify(make(), [prefix({ shown: Array(512).fill("g") }), { kind: "line", threadId: "T", messageId: "g" }])).toEqual(incomplete("ids")));
  it.each(["own", "wildcard", "combined", "above-head", "audience"])("C5a pending raw limit %s", mode => {
    const f = make();
    for (let i = 0; i < 257; i++) f.pending(mode === "wildcard" || (mode === "combined" && i >= 129) ? "*" : "T", mode === "above-head" && i ? i + 100 : i, i + 1);
    if (mode === "audience") f.db.exec("INSERT INTO memory_revoke_audience SELECT revoke_id FROM memory_deny_pending WHERE since_lsn<256");
    expect(classify(f)).toEqual(incomplete("pending-rows"));
  });
  it("C6/C7 withheld wins over pending", () => expect(classify(job(make()).denyLine("T", 10))).toEqual(outside("withheld")));
  it("C6/C7 checking not ready", () => expect(classify(job(make()).ready("T", false))).toEqual(outside("checking-thread-not-ready")));
  it("C6/C7 checking no lineage", () => { const f = job(make()); f.db.exec("DELETE FROM memory_line_lineage"); expect(classify(f)).toEqual(outside("checking-no-lineage")); });
  it("C7 own line past head", () => expect(classify(job(make(), 1, "T", 11).reply("T", "late", 12), [prefix(), { kind: "line", threadId: "T", messageId: "late" }])).toEqual(outside("beyond-head")));
  it("C8 65 memory refs", () => expect(classify(make(), [prefix(), ...Array.from({ length: 65 }, () => ({ kind: "memory", ref: { kind: "record", id: "r", version: 1 } } as const))])).toEqual(outside("nested-ref")));
  it.each(["SUPPORT_FAN_IN", "RECORD_ANCHORS", "DERIVATION_WALK", "RECEIPT_ANCHORS"])("C8 excludes %s without nested reads", limit => {
    const f = job(make());
    const nested: LineageRef = limit === "RECEIPT_ANCHORS" ? { kind: "receipt", bundleId: "r", lsn: 1, scopeIds: [] } : { kind: "memory", ref: { kind: limit === "SUPPORT_FAN_IN" ? "source" : "record", id: "r", version: 1 } };
    f.db.exec("BEGIN");
    if (limit === "SUPPORT_FAN_IN") {
      f.source("r", "s-room");
      for (let i = 0; i < 65; i++) f.record(`c${i}`, 1, "s-room", ["r"]);
    } else if (limit === "RECEIPT_ANCHORS") {
      f.receipt("r", "T", "fake", "session");
      f.db.prepare("UPDATE memory_disclosures SET source_versions=?").run(JSON.stringify(Array.from({ length: 2049 }, (_, i) => ({ id: `s${i}`, revision: 1 }))));
    } else {
      f.record("r", 1, "s-room");
      // Parent rows exercise both limits without introducing unrelated source flags.
      const count = limit === "RECORD_ANCHORS" ? 2049 : 257;
      for (let i = 0; i < count; i++) f.record(`p${i}`, 1, "s-room").derive(`p${i}`, 1, "r", 1);
    }
    f.db.exec("COMMIT");
    expect(refsLookup(f.db, [nested], CONTENT)).toEqual({ state: "checking", reason: "pending" });
    resetDenyReadMeter();
    expect(classify(f, [prefix(), nested])).toEqual(outside("nested-ref"));
    expect(denyReadMeter().sql.join("\n")).not.toMatch(/memory_(records|evidence|derivations|disclosures)/);
  });
  it("C2 unfinished part enumeration", () => {
    const f = make(); const parts = [] as ReturnType<typeof promptPart>[];
    parts[Symbol.iterator] = function* () { while (true) yield promptPart("", [{ kind: "none", reason: "static" }]); };
    expect(target.classifyDirectSettle(f.db, { parts }, CONTENT, { threadId: "T" })).toEqual(incomplete("refs"));
  });
  it("C7 an unaccounted part cannot clear", () => {
    const f = make(); const p = buildPrompt(undefined, [promptPart("", [prefix()]), promptPart("", [])]);
    expect(target.classifyDirectSettle(f.db, p, CONTENT, { threadId: "T" })).toEqual(outside("checking-no-lineage"));
  });
  it("C12 exact oldest unrelated flow must be eligible", () => {
    const f = job(make(), 2, "*"); job(f, 1, "U");
    f.db.exec("UPDATE memory_revoke_jobs SET state='active',kind='bulk',root='{\"kind\":\"bulk\",\"cause\":\"forget\"}' WHERE revoke_id=1");
    expect(classify(f)).toEqual(outside("job-kind"));
  });
  it("C12 cursor must describe an object", () => { const f = job(make()); f.db.exec("UPDATE memory_revoke_jobs SET cursor='[]'"); expect(classify(f)).toEqual(incomplete("job")); });
  it("C12 job JSON processing has a raw allowance", () => {
    const f = job(make()); f.db.prepare("UPDATE memory_revoke_jobs SET cursor=?").run(JSON.stringify({ entries: Array(4100).fill(0) })); expect(classify(f)).toEqual(incomplete("work"));
  });
  it("fold sampling is unknown without its prerequisite", () => { const f = make(); f.db.exec("DROP INDEX IF EXISTS memory_revoke_jobs_seeding_fold"); expect(target.seedingFoldExists(f.db)).toBeNull(); });
  it("C9 clear", () => expect(classify(make())).toEqual({ kind: "clear" }));
  it("C10 own", () => expect(classify(job(make()))).toEqual(own));
  it("C10 duplicate rows collapse only after raw bound", () => { const f = job(make()); for (let i = 2; i <= 200; i++) f.pending("T", i, 1); expect(classify(f)).toEqual(own); });
  it("C10 wildcard gives flows", () => expect(classify(job(job(make()), 2, "*"))).toEqual({ kind: "flows", threadId: "T", headLsn: 10, targets: [1], flowIds: [2] }));
  it.each(["T", "*"])("C11 33 distinct %s targets", thread => { const f = make(); for (let i = 1; i <= 33; i++) job(f, i, thread); expect(classify(f)).toEqual(incomplete("targets")); });
  it("C12 seeding fold anywhere", () => { const f = job(make()); f.job(99, 20, "seeding"); f.db.exec(`UPDATE memory_revoke_jobs SET kind='bulk',root='{"cause":"fold"}' WHERE revoke_id=99`); expect(classify(f)).toEqual(outside("fold-seeding")); });
  it.each(["old", "bulk"])("C12 folded %s id", side => { const f = job(make()); f.db.prepare("INSERT INTO memory_revoke_fold VALUES(?,?)").run(side === "old" ? 1 : 99, side === "old" ? 99 : 1); expect(classify(f)).toEqual(outside("fold")); });
  it.each(["bulk", "thread", "bot"])("C12 excluded %s job", kind => { const f = job(make()); f.db.prepare("UPDATE memory_revoke_jobs SET kind=?,root=?").run(kind, JSON.stringify({ kind, cause: kind === "bulk" ? "forget" : `delete-${kind === "thread" ? "conversation" : "bot"}` })); expect(classify(f)).toEqual(outside("job-kind")); });
  it.each(["done", "undoing", "seeding"])("C12 nonactive %s job", state => { const f = job(make()); f.db.prepare("UPDATE memory_revoke_jobs SET state=?").run(state); expect(classify(f)).toEqual(outside("job-state")); });
  it("C12 missing job", () => expect(classify(make().pending("T", 1))).toEqual(outside("job-missing")));
  it.each(["{", "{}", "null", '"string"'])("C12 malformed root %s", root => { const f = job(make()); f.db.prepare("UPDATE memory_revoke_jobs SET root=?").run(root); expect(classify(f)).toEqual(incomplete("job")); });
  it.each(["root", "cursor"])("C12 oversized %s before copying", column => { const f = job(make()); f.db.prepare(`UPDATE memory_revoke_jobs SET ${column}=?`).run("x".repeat(65537)); expect(classify(f)).toEqual(incomplete("work")); });
  it("C12 missing fold index", () => { const f = job(make()); f.db.exec("DROP INDEX IF EXISTS memory_revoke_jobs_seeding_fold"); expect(classify(f)).toEqual(incomplete("error")); });
  it("C12 missing flow index", () => { const f = job(make(), 1, "*"); f.db.exec("DROP INDEX IF EXISTS memory_revoke_jobs_active_flow"); expect(classify(f)).toEqual(incomplete("error")); });
  it("C13 slow lookup", () => { const f = job(make()); const prepare = f.db.prepare.bind(f.db); vi.spyOn(f.db, "prepare").mockImplementation(sql => { vi.mocked(performance.now).mockReturnValue(26); return prepare(sql); }); expect(classify(f)).toEqual(incomplete("time")); });
  it("C14 lookup throw", () => { const f = make(); vi.spyOn(f.db, "prepare").mockImplementation(() => { throw Error("unavailable"); }); expect(classify(f)).toEqual(incomplete("error")); });
  it.each(["marks", "ranges", "tombstones"])("raw work before filtering %s", type => {
    const f = job(make());
    f.db.exec("BEGIN");
    for (let i = 1; i <= 4100; i++) {
      if (type === "marks") f.denyLine("T", 10, i);
      else if (type === "ranges") f.denyRange("T", 0, 0, i);
      else f.tombstone("source", "message:T:g", i);
      f.db.prepare("INSERT OR IGNORE INTO memory_revoke_audience VALUES(?)").run(i);
    }
    f.db.exec("COMMIT");
    expect(classify(f)).toEqual(incomplete("work"));
  });
  it("source revision payload is bounded before parsing", () => {
    const f = make().source("message:T:g", "s-room", { kind: "bring-in" });
    f.db.prepare("UPDATE memory_source_versions SET payload=?").run(JSON.stringify({ extra: "x".repeat(65536) }));
    expect(classify(f)).toEqual(incomplete("work"));
  });
  it("source revisions use the exact current primary key", () => {
    const f = make().source("message:T:g", "s-room", { kind: "bring-in" });
    f.db.exec("BEGIN");
    for (let i = 2; i <= 4200; i++) f.db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES('message:T:g',?,'h','{}',0)").run(i);
    f.db.exec("COMMIT");
    resetDenyReadMeter(); expect(classify(f)).toEqual({ kind: "clear" }); expect(denyReadMeter().rows).toBeLessThan(40);
  });
  it("database message text bound before parsing", () => { const f = make().message("T", "g", "bot", { extra: "x".repeat(65536) }); expect(classify(f)).toEqual(incomplete("work")); });
  it("total text bound before copying", () => {
    const f = make(); const ids = Array.from({ length: 25 }, (_, i) => `b${i}`);
    for (let i = 0; i < ids.length; i++) f.reply("T", ids[i]!, 100 + i).message("T", ids[i]!, "bot", { extra: "x".repeat(50000) });
    expect(classify(f, [prefix({ headLsn: 200, shown: ids })])).toEqual(incomplete("work"));
  });
  it("indexed fold and flow probes, pending and content raw plans", () => {
    const f = job(make()); resetDenyReadMeter(); expect(classify(f)).toEqual(own);
    for (const sql of [target.SEEDING_FOLD_SQL, target.ACTIVE_FLOW_SQL]) {
      const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r => String(r.detail)).join("\n");
      expect(plan).toMatch(/USING (?:COVERING )?INDEX memory_revoke_jobs_/); expect(plan).not.toMatch(/TEMP B-TREE/);
    }
    for (const sql of denyReadMeter().sql) {
      if (sql === target.SEEDING_FOLD_SQL || sql === target.ACTIVE_FLOW_SQL) continue;
      const params = Array((sql.match(/\?/g) ?? []).length).fill(1);
      const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => String(r.detail)).join("\n");
      expect(plan, sql).not.toMatch(/SCAN |TEMP B-TREE/);
    }
  });
  it.each([["active", "bulk", "fold"], ["seeding", "line", "fold"], ["seeding", "bulk", "forget"]])("fold predicate excludes %s/%s/%s", (state, kind, cause) => {
    const f = make(); f.job(99, 20);
    f.db.prepare("UPDATE memory_revoke_jobs SET state=?,kind=?,root=?").run(state, kind, JSON.stringify({ cause }));
    expect(target.seedingFoldExists(f.db)).toBe(false);
  });
  it("malformed roots cannot break index maintenance", () => { const f = make(); f.job(99, 20, "seeding"); f.db.exec("UPDATE memory_revoke_jobs SET kind='bulk',root='not-json'"); expect(target.seedingFoldExists(f.db)).toBe(false); });
});

describe("T2b fence dependency interface stays unattached", () => {
  it("no injected classifier", () => { const f = make(); expect(fence.classifyRefusal(built(), CONTENT, { threadId: "T" }, f.db)).toEqual(incomplete("no-classifier")); });
  it("resolved fence database and injected classification", () => {
    const f = make(), other = make(); const classify = vi.fn((..._args: unknown[]) => ({ kind: "clear" } as const));
    fence.setSendFenceDeps({ db: () => f.db, classify });
    expect(fence.fenceDatabase()).toBe(f.db); expect(fence.fenceDatabase(other.db)).toBe(other.db);
    expect(fence.classifyRefusal(built(), CONTENT, { threadId: "T" }, other.db)).toEqual({ kind: "clear" });
    expect(classify.mock.calls[0]?.[0]).toBe(other.db);
    fence.setSendFenceDeps({ classify: null, db: null });
  });
  it("C0 room fence never classifies", () => {
    const f = job(make()); const classify = vi.fn(); expect(fence.fenceDatabase(f.db)).toBe(f.db); fence.setSendFenceDeps({ classify });
    expect(() => fence.assertSendFence(built(), MEMBER, f.db)).toThrow("MEMORY_CONTEXT_REVOKED"); expect(classify).not.toHaveBeenCalled();
    fence.setSendFenceDeps({ classify: null });
  });
  it("no database", () => { fence.setSendFenceDeps({ classify: () => ({ kind: "clear" }), db: null }); expect(fence.classifyRefusal(built(), CONTENT, { threadId: "T" })).toEqual(incomplete("no-classifier")); fence.setSendFenceDeps({ classify: null }); });
});

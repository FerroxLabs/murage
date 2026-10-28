// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 5.4 (Astra 8): which turns carry the email-derived mark, how the mark survives a restart, and the memory and routine surfaces fenced
// from marked rows (memory search/get hits, consolidation input, a routine's carried report).
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { beginTurnMarks, forgetAllTurnMarks, markTurnEmailDerived, noteSessionStart, persistTurnMarks, promptCarriesEmailDerived, sessionStartSeq, fenceEmailDerived, turnEmailDerived, type TurnMarkStore } from "./external-marks.ts";
import { evidenceEmailDerived, fenceEmailDerivedRecords } from "../memory/email-derived.ts";

const FENCED = /^<<page-content id=[0-9a-f]+ origin=row:\S+ kind=email-derived>>\n/;
const branch = [
  { id: "u1", seq: 1 }, { id: "b1", seq: 2, externalContent: "email" as const }, { id: "u2", seq: 3 }, { id: "b2", seq: 4 },
];

function memStore(): TurnMarkStore & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    all: () => [...rows.keys()].filter(key => key.startsWith("t:")).map(key => key.slice(2)),
    add: id => { rows.set(`t:${id}`, "1"); },
    remove: id => { rows.delete(`t:${id}`); },
    sessionFrom: (thread, instance) => { const raw = rows.get(`s:${thread}:${instance}`); return raw === undefined ? undefined : Number(raw); },
    setSessionFrom: (thread, instance, seq) => { rows.set(`s:${thread}:${instance}`, String(seq)); },
  };
}

afterEach(() => forgetAllTurnMarks());

describe("which turn carries the mark", () => {
  it("a fresh turn is marked only when its replay or its prompt rows carry a marked row", () => {
    expect(promptCarriesEmailDerived({ resumed: false, replayIds: ["u2", "b2"], promptIds: [], branch })).toBe(false);
    expect(promptCarriesEmailDerived({ resumed: false, replayIds: ["u1", "b1", "u2"], promptIds: [], branch })).toBe(true);
    expect(promptCarriesEmailDerived({ resumed: false, replayIds: [], promptIds: ["b1"], branch })).toBe(true);
  });

  it("a resumed session is marked only when its own transcript since it started holds a marked row; no record reads the whole branch", () => {
    expect(promptCarriesEmailDerived({ resumed: true, replayIds: [], promptIds: [], branch, sessionFromSeq: 2 })).toBe(false);
    expect(promptCarriesEmailDerived({ resumed: true, replayIds: [], promptIds: [], branch, sessionFromSeq: 1 })).toBe(true);
    expect(promptCarriesEmailDerived({ resumed: true, replayIds: [], promptIds: [], branch })).toBe(true);
    expect(promptCarriesEmailDerived({ resumed: true, replayIds: [], promptIds: [], branch: branch.map(({ externalContent: _drop, ...row }) => row) })).toBe(false);
    // a read whose turn wrote no reply: its result is still in the session
    const read = [{ id: "a1", seq: 5, kind: "activity", tool: { name: "mcp__agents__email_read" } }];
    expect(promptCarriesEmailDerived({ resumed: true, replayIds: [], promptIds: [], branch: read, sessionFromSeq: 4 })).toBe(true);
    expect(promptCarriesEmailDerived({ resumed: true, replayIds: [], promptIds: [], branch: read, sessionFromSeq: 5 })).toBe(false);
    expect(promptCarriesEmailDerived({ resumed: false, replayIds: ["a1"], promptIds: [], branch: read })).toBe(false);
  });

  it("a prompt that itself carries email-derived text (a carried routine report) marks the turn", () => {
    const report = fenceEmailDerived("Alex asked for the invoice.", "routine-run-r1").split("\n").map(line => `> ${line}`).join("\n");
    expect(promptCarriesEmailDerived({ resumed: true, promptText: `Do the daily check.\n\nPrevious run's report:\n${report}`, replayIds: [], promptIds: [], branch: [], sessionFromSeq: 9 })).toBe(true);
    expect(promptCarriesEmailDerived({ resumed: true, promptText: "kind=email-derived in plain words", replayIds: [], promptIds: [], branch: [], sessionFromSeq: 9 })).toBe(false);
  });
});

describe("the mark survives a restart", () => {
  it("is written through, loaded back on wiring, and cleared when the thread's next turn begins", () => {
    const durable = memStore();
    persistTurnMarks(durable);
    markTurnEmailDerived("th1");
    expect(durable.all()).toEqual(["th1"]);
    forgetAllTurnMarks(); // the crash: memory gone
    expect(turnEmailDerived("th1")).toBe(false);
    persistTurnMarks(durable); // boot
    expect(turnEmailDerived("th1")).toBe(true);
    beginTurnMarks("th1");
    expect(turnEmailDerived("th1")).toBe(false);
    expect(durable.all()).toEqual([]);
  });

  it("records where a session's transcript starts, per thread and engine", () => {
    const durable = memStore();
    expect(sessionStartSeq("th1", "claude")).toBeUndefined();
    persistTurnMarks(durable);
    noteSessionStart("th1", "claude", 41);
    noteSessionStart("th1", "codex", undefined);
    expect(sessionStartSeq("th1", "claude")).toBe(41);
    expect(sessionStartSeq("th1", "codex")).toBeUndefined();
  });
});

describe("memory records resting on a marked row", () => {
  const db = () => {
    const d = new DatabaseSync(":memory:");
    d.exec("CREATE TABLE memory_source_versions (source_id TEXT, revision INTEGER, payload TEXT)");
    d.prepare("INSERT INTO memory_source_versions VALUES (?,?,?)").run("s-mail", 1, JSON.stringify({ text: "x", externalContent: "email" }));
    d.prepare("INSERT INTO memory_source_versions VALUES (?,?,?)").run("s-plain", 1, JSON.stringify({ text: "y" }));
    return d;
  };

  it("are fenced kind email-derived and mark the reader's turn; others are unchanged", () => {
    const d = db();
    expect(evidenceEmailDerived(d, [{ sourceId: "s-plain", revision: 1 }])).toBe(false);
    expect(evidenceEmailDerived(d, [{ sourceId: "s-plain", revision: 1 }, { sourceId: "s-mail", revision: 1 }])).toBe(true);
    expect(evidenceEmailDerived(d, [{ sourceId: "s-mail", revision: 2 }])).toBe(false);
    const plain = fenceEmailDerivedRecords(d, [{ id: "r1", text: "Owner likes tea", evidence: [{ sourceId: "s-plain", revision: 1 }] }], "th2");
    expect(plain[0]!.text).toBe("Owner likes tea");
    expect(turnEmailDerived("th2")).toBe(false);
    const out = fenceEmailDerivedRecords(d, [{ id: "r2", text: "Alex wants a refund", evidence: [{ sourceId: "s-mail", revision: 1 }] }], "th2");
    expect(out[0]!.text).toMatch(FENCED);
    expect(out[0]!.text).toContain("Alex wants a refund");
    expect(turnEmailDerived("th2")).toBe(true);
    // never fenced twice
    expect(fenceEmailDerivedRecords(d, out, "th2")[0]!.text).toBe(out[0]!.text);
  });
});

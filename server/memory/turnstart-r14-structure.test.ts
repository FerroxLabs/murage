// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14 sec. 6 T11 structure, (a), (j), (k): source-level checks of the store's ownership (four private maps), the handle
// epoch at every handle-layer clear site, and the confirm's synchrony. They read the source files; nothing is run.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const source = (name: string) => readFileSync(here(name), "utf8");
const STORE = "verdict-store.ts";
/** Module-level Map/Set/WeakMap/WeakSet declarations (column 0 `const`/`let`), by name. */
const moduleMaps = (text: string) => [...text.matchAll(/^(?:export )?(?:const|let) ([A-Za-z_$][\w$]*)(?:\s*:[^=\n]+)?\s*=\s*new (?:Map|Set|WeakMap|WeakSet)\b/gm)].map(match => match[1]!);
/** The four maps r14 S1' moves into the store. */
const STORE_MAPS = ["verdicts", "sessionSound", "threadGroupStore", "sessionHolds"];
/** T11(a) ALLOWED LIST (design 1B, Fable r13 L1) plus the b13e connection/statement/bookkeeping maps that hold no verdict, hold or group. */
const ALLOWED = new Set(["sharedHandles", "partialWalks", "chains", "audienceHolds", "proving",
  "statements", "warned", "wantedThreads", "threadForgetsCache", "threadForgetsPass", "dependents", "epochReady", "foreignSeen", "judging", "prepared", "chainedTable", "chainWriters"]);

describe("T11(a) four private maps in the VerdictStore", () => {
  it("verdict-store.ts exists and holds verdicts, sessionSound, threadGroupStore and sessionHolds as # fields", () => {
    expect(existsSync(here(STORE)), "server/memory/verdict-store.ts (r14 sec. 2)").toBe(true);
    const text = source(STORE);
    for (const name of STORE_MAPS) expect(text, `#${name}`).toMatch(new RegExp(`#${name}\\b`));
  });
  it("no module-level store map remains in replay-lineage.ts or disclosures.ts; no `new Map<string, Hold>` outside the store", () => {
    for (const file of ["replay-lineage.ts", "disclosures.ts", "root-set-handles.ts"]) {
      const text = source(file), names = moduleMaps(text);
      expect(names.filter(name => STORE_MAPS.includes(name)), `${file}: store maps still module-level`).toEqual([]);
      expect(names.filter(name => !ALLOWED.has(name) && !STORE_MAPS.includes(name)), `${file}: module-level maps not on the allowed list`).toEqual([]);
      expect(text, `${file}: Hold map`).not.toMatch(/new Map<string,\s*Hold>/);
    }
  });
  it("disclosures.ts reaches holds only through the store's accessors (getHold, touchHold, loseHold, setHold, resetSessionHolds)", () => {
    const text = source("disclosures.ts");
    expect(text).not.toMatch(/sessionHolds\.(get|set|delete|clear|has)\(/);
    for (const accessor of ["getHold", "touchHold", "loseHold", "setHold"]) expect(text, accessor).toMatch(new RegExp(`\\b${accessor}(?:<[^>()]*>)?\\(`));
  });
});

describe("T11(j) every handle-layer clear site moves handleEpoch", () => {
  it("root-set-handles.ts: forgetRootSetHandles (RH:139) and the capacity clear (RH:211) call the onHandlesForgotten hook", () => {
    const text = source("root-set-handles.ts");
    expect(text).toMatch(/export function onHandlesForgotten\(/);
    const forget = text.match(/export function forgetRootSetHandles\([^)]*\)[^{]*\{[^\n]*/)?.[0] ?? "";
    expect(forget, "RH:139").toMatch(/handlesForgotten\w*\(/);
    const remember = text.match(/function remember\(cache: HandleCache[\s\S]*?\n\}/)?.[0] ?? "";
    expect(remember, "RH:211 capacity clear").toMatch(/cache\.clear\(\)[^\n]*handlesForgotten\w*\(|handlesForgotten\w*\([^\n]*cache\.clear\(\)/);
  });
  it("replay-lineage.ts: the chains.clear() sites that coincide with handle clears (RL:1986, :1987) and the per-handle drop (RL:2404) bump handleEpoch on the same line; the standalone size clear (RL:1990) does not (r15 sec. 4, Fable L3: chains is judge-only)", () => {
    const lines = source("replay-lineage.ts").split("\n");
    const all = lines.map((line, index) => ({ line, at: index + 1 })).filter(({ line }) => /chains\.clear\(\)|cache\.delete\(setId\)/.test(line));
    const standalone = all.filter(({ line }) => /chains\.size\s*>/.test(line));
    const sites = all.filter(site => !standalone.includes(site));
    expect(standalone.length, "the RL:1990 size clear is still there").toBe(1);
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const { line, at } of sites) expect(line, `RL:${at}`).toMatch(/bumpHandleEpoch\(/);
    expect(standalone[0]!.line, `RL:${standalone[0]!.at}`).not.toMatch(/bump\w*Epoch\(/);
  });
  it("replay-lineage.ts: forget lists are never reused across calls without a handleEpoch bump (b13e: the eviction bumps; TCFO r3: in-pass threadForgetsPass only, no cross-call cache)", () => {
    const text = source("replay-lineage.ts");
    if (/\bthreadForgetsCache\b/.test(text)) expect(text).toMatch(/threadForgetsCache\.delete\(victim\);\s*bumpHandleEpoch\("forgets"\)/);
    else expect(text, "TCFO r3 in-pass reuse").toMatch(/\bthreadForgetsPass\b/);
  });
});

describe("T11(h) r15: one compare, then record, at the dispatch site only", () => {
  it("index.ts calls compareLineageFootprint exactly once, before noteLineageFootprint, and never at the early (IX:12705) site", () => {
    const text = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    const compares = [...text.matchAll(/compareLineageFootprint\(/g)].map(m => m.index!);
    const notes = [...text.matchAll(/noteLineageFootprint\(/g)].map(m => m.index!);
    expect(compares.length, "one compare site (r15 sec. 0)").toBe(1);
    expect(notes.length, "one record site").toBe(1);
    expect(compares[0]!, "compare before record (r14.1 order fix)").toBeLessThan(notes[0]!);
    const between = text.slice(compares[0]!, notes[0]!);
    expect(between.split("\n").length, "the record follows the compare in the same block").toBeLessThan(12);
  });
});

describe("T11(k) the confirm is synchronous", () => {
  it("lineage-warm.ts has a confirm function with a non-Promise return type and no await in its body", () => {
    const text = source("lineage-warm.ts");
    const match = text.match(/\n(export )?(async )?function (confirm\w*)\(([^)]*)\)\s*:\s*([^{]+)\{/);
    expect(match, "a function confirm*() in lineage-warm.ts (r14 C5')").not.toBeNull();
    expect(match![2], "async").toBeUndefined();
    expect(match![5]!).not.toMatch(/Promise/);
    const start = text.indexOf(match![0]), end = text.indexOf("\n}", start);
    expect(text.slice(start, end)).not.toMatch(/\bawait\b/);
  });
});

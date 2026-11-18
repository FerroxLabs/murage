// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLAUSE-MUTANT RUN (r3.4d restore plan, step 1). Gated: runs only with CM_RUN=1, after clause-mutants/gen.mjs has written
// clause-mutants/clauses.json and the schema copy invariants.cm-schema.ts. For every clause id: remove that one clause (__setCM(id)),
// run the full spec witness set (each witness through its own predicate) and then the combined gate (every predicate over every
// must-accept witness). KILLED = some witness gets the wrong verdict (killer = that witness) or the combined gate fails; else SURVIVED.
// A SURVIVED clause is closed by a new must-reject witness named after it, or by a REDUNDANT claim in clause-mutants/redundant.json,
// GROUPS: CM_GROUP=gN runs only that group's predicates (clause-mutants/groups.json, CM-GROUPS.md), writes CLAUSE-MUTANTS-gN.md + results-gN.json and
// reads clause-mutants/cm-verdicts-gN.json (clause id -> {verdict: KILLED|REDUNDANT|EQUIVALENT, witness?, argument?, by?, byLine?}); the run FAILS when a
// surviving clause has no entry, a KILLED entry's witness does not really kill, a REDUNDANT proof fails, an EQUIVALENT entry has no argument, or an entry is stale.
// Without CM_GROUP all verdict files found are applied (enforced only with CM_STRICT=1). which this run PROVES: the proof witness is rejected by the clause (unmutated predicate rejects, clause-removed predicate accepts) and
// the cited predicate rejects it too. Writes clause-mutants/results.json and CLAUSE-MUTANTS-r34d.md (CM_MD).

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Verdict } from "./invariants.current.ts";
import { fromRegistries, type PredicateSet } from "./predicates.ts";
import { verdictViaPredicates } from "./witnesses/specRun.ts";
import { WITNESSES } from "./witnesses/witnesses-all.ts";

interface Clause { id: string; predicate: string; kind: string; line: number; text: string; ctx?: string; chain?: string; dir?: string }
interface Redundant { by: string; byLine: number; witness: string; note: string }
interface Row extends Clause { verdict: "KILLED" | "SURVIVED" | "REDUNDANT" | "EQUIVALENT"; killer: string; how: string }
type EqKind = "NULL" | "SHADOW" | "COMBINED";
interface VerdictEntry { verdict: "KILLED" | "REDUNDANT" | "EQUIVALENT"; witness?: string; argument?: string; by?: string; byLine?: number; kind?: EqKind; separating?: string; shadowedBy?: number }
// EQUIVALENT kinds (MurageMain ruling 2026-11-11): NULL = a null/undefined lookup already false (accepted as defensive, step 3 marks it type-narrowing, Opus step 4 confirms);
// SHADOW = another check in the SAME predicate returns the violation first (NOT accepted: step 3 removes the duplicate, a re-run must show 0 survivors);
// COMBINED = a DIFFERENT predicate (by/byLine) rejects every history that would separate the clause: needs `separating`, the id of a history in witnesses/separating-g*.ts
// (NOT a witness of the gates), and the run proves (2) the clause mutant and the original disagree on it and (3) the cited predicate rejects it.
// The cap counts NULL + COMBINED only.
interface SepWitness { id: string; invariant: string; trace: Parameters<typeof verdictViaPredicates>[2]; settled: boolean }
const SEPARATING: SepWitness[] = Object.values((import.meta as unknown as { glob: (p: string, o: { eager: true }) => Record<string, unknown> }).glob("./witnesses/separating-g*.ts", { eager: true }) as Record<string, { SEPARATING?: SepWitness[] }>).flatMap(m => m.SEPARATING ?? []);
const DIR = path.join(__dirname, "clause-mutants");
type Schema = { __setCM: (x: string) => void; STEP_INVARIANTS: never; STATE_INVARIANTS: never; TRACE_INVARIANTS: Record<string, (t: unknown, b: unknown) => Verdict>; CHECKER: { livenessBound: unknown } };

// KEPT GATED ON PURPOSE: this runs every clause mutant (minutes) so the normal suite skips it; cm-strict.sh sets CM_RUN=1 CM_STRICT=1 and runs it as a required gate (SURVIVED must be 0).
describe.skipIf(!process.env.CM_RUN)("clause mutants (CM_RUN=1)", () => {
  it("runs every clause mutant against the witness set and the combined gate", async () => {
    const M = (await import(/* @vite-ignore */ path.join(__dirname, "invariants.cm-schema.ts"))) as Schema;
    const ps: PredicateSet = fromRegistries("clause-mutant", M.STEP_INVARIANTS, M.STATE_INVARIANTS, {
      keepEndsActive: (t, s) => M.TRACE_INVARIANTS.keepEndsActive(t, s), quiescenceReachable: t => M.TRACE_INVARIANTS.quiescenceReachable(t, M.CHECKER.livenessBound),
      heldInputDrains: t => M.TRACE_INVARIANTS.heldInputDrains(t, M.CHECKER.livenessBound),
    });
    const names = [...Object.keys(ps.step), ...Object.keys(ps.state), ...Object.keys(ps.trace)];
    const GROUP = process.env.CM_GROUP ?? "";
    const groups = (JSON.parse(fs.readFileSync(path.join(DIR, "groups.json"), "utf8")) as { groups: Record<string, string[]> }).groups;
    if (GROUP) expect(Object.keys(groups), "CM_GROUP must be one of the groups in groups.json").toContain(GROUP);
    const inGroup = new Set(GROUP ? groups[GROUP] : []);
    const all = (JSON.parse(fs.readFileSync(path.join(DIR, "clauses.json"), "utf8")) as { clauses: Clause[] }).clauses;
    const clauses = GROUP ? all.filter(c => inGroup.has(c.predicate)) : all;
    const readJson = (f: string): Record<string, unknown> => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {}) as Record<string, unknown>;
    const verdicts: Record<string, VerdictEntry> = {};
    for (const g of GROUP ? [GROUP] : Object.keys(groups)) Object.assign(verdicts, readJson(path.join(DIR, "cm-verdicts-" + g + ".json")));
    const strict = !!GROUP || !!process.env.CM_STRICT;
    const errors: string[] = [];
    const redundant = readJson(path.join(DIR, "redundant.json")) as Record<string, Redundant>;
    for (const [id, e] of Object.entries(verdicts)) if (e.verdict === "REDUNDANT" && e.witness && e.by) redundant[id] = { by: e.by, byLine: e.byLine ?? 0, witness: e.witness, note: e.argument ?? "" };
    const accepts = WITNESSES.filter(w => w.expect === "accept");
    const judgeOne = (w: (typeof WITNESSES)[number]): boolean => { const v = run(w.invariant, w); return v !== "throw" && (w.expect === "reject" ? rejects(v, w.invariant) : v.ok); };
    const run = (n: string, w: (typeof WITNESSES)[number]): Verdict | "throw" => { try { return verdictViaPredicates(ps, n, w.trace, w.settled); } catch { return "throw"; } };
    const rejects = (v: Verdict | "throw", n: string): boolean => v !== "throw" && !v.ok && v.invariant === n;
    const judge = (): { killer: string; how: string } | null => {
      for (const w of WITNESSES) {
        const v = run(w.invariant, w);
        if (v === "throw") return { killer: w.id, how: "predicate threw" };
        if (w.expect === "reject" && !rejects(v, w.invariant)) return { killer: w.id, how: "must-reject accepted" };
        if (w.expect === "accept" && !v.ok) return { killer: w.id, how: "must-accept rejected" };
      }
      for (const w of accepts) for (const n of names) {
        const v = run(n, w);
        if (v === "throw" || !v.ok) return { killer: "combined:" + w.id + "/" + n, how: v === "throw" ? "predicate threw" : "combined gate failure" };
      }
      return null;
    };
    const killsWith = (w: (typeof WITNESSES)[number]): boolean => {
      const v = run(w.invariant, w);
      if (v === "throw") return true;
      if (w.expect === "reject" ? !rejects(v, w.invariant) : !v.ok) return true;
      return w.expect === "accept" && names.some(n => { const x = run(n, w); return x === "throw" || !x.ok; });
    };
    M.__setCM("");
    expect(judge()).toBeNull(); // the schema copy is the spec when no clause is removed
    const rows: Row[] = [];
    const t0 = Date.now();
    for (const c of clauses) {
      M.__setCM(c.id);
      const k = judge();
      rows.push(k ? { ...c, verdict: "KILLED", ...k } : { ...c, verdict: "SURVIVED", killer: "", how: "" });
    }
    // redundancy proofs
    const proofs: string[] = [];
    for (const r of rows.filter(x => x.verdict === "SURVIVED" && redundant[x.id])) {
      const p = redundant[r.id], w = WITNESSES.find(x => x.id === p.witness);
      if (!w) { proofs.push(r.id + ": proof witness " + p.witness + " missing"); continue; }
      M.__setCM(""); const withClause = run(r.predicate, w), cited = run(p.by, w);
      M.__setCM(r.id); const without = run(r.predicate, w);
      M.__setCM("");
      const ok = rejects(withClause, r.predicate) && !rejects(without, r.predicate) && rejects(cited, p.by) && w.invariant === p.by && w.expect === "reject";
      proofs.push("redundancy proof " + r.id + " via " + p.witness + ": " + r.predicate + " with clause " + (rejects(withClause, r.predicate) ? "REJECTS" : "accepts") + ", without clause " + (rejects(without, r.predicate) ? "rejects" : "ACCEPTS") + ", " + p.by + " " + (rejects(cited, p.by) ? "REJECTS" : "accepts") + " => " + (ok ? "PROVEN" : "NOT PROVEN"));
      if (ok) { r.verdict = "REDUNDANT"; r.killer = p.by + ":" + p.byLine + " via " + p.witness; r.how = p.note; }
    }
    M.__setCM("");
    // verdict file: every entry is checked against what the run actually shows
    const ids = new Set(clauses.map(c => c.id));
    for (const [id, e] of Object.entries(verdicts)) {
      if (!ids.has(id)) { if (strict || all.some(c => c.id === id)) errors.push(id + ": verdict entry for a clause that is not " + (GROUP ? "in " + GROUP : "a known clause")); continue; }
      const r = rows.find(x => x.id === id)!;
      if (!["KILLED", "REDUNDANT", "EQUIVALENT"].includes(e.verdict)) { errors.push(id + ": unknown verdict " + String(e.verdict)); continue; }
      if (e.verdict === "KILLED") {
        const w = WITNESSES.find(x => x.id === e.witness);
        if (!e.witness || !w) { errors.push(id + ": KILLED entry names no existing witness (" + String(e.witness) + ")"); continue; }
        M.__setCM(""); const okClean = judgeOne(w);
        M.__setCM(id); const kills = killsWith(w); M.__setCM("");
        if (!okClean) errors.push(id + ": KILLED by " + e.witness + " but that witness is wrong on the unmutated spec");
        else if (!kills) errors.push(id + ": KILLED claimed by " + e.witness + " but the witness does not kill the clause mutant");
      } else if (r.verdict === "KILLED") errors.push(id + ": stale " + e.verdict + " entry, the clause is killed by " + r.killer);
      else if (e.verdict === "REDUNDANT") { if (r.verdict !== "REDUNDANT") errors.push(id + ": REDUNDANT proof not proven (witness/by missing or the proof line above says NOT PROVEN)"); }
      else if (!e.argument || e.argument.trim().length < 20) errors.push(id + ": EQUIVALENT needs an argument");
      else if (!e.kind || !["NULL", "SHADOW", "COMBINED"].includes(e.kind)) errors.push(id + ": EQUIVALENT needs kind NULL | SHADOW | COMBINED");
      else if (e.kind === "SHADOW" && !(typeof e.shadowedBy === "number" && e.shadowedBy > 0)) errors.push(id + ": SHADOW needs shadowedBy (line of the same-predicate check that returns first)");
      else if (e.kind === "COMBINED") {
        const sw = SEPARATING.find(x => x.id === e.separating);
        if (!e.separating || !sw) { errors.push(id + ": COMBINED needs separating = the id of a history in witnesses/separating-g*.ts (" + String(e.separating) + ")"); continue; }
        if (!e.by || !e.byLine) { errors.push(id + ": COMBINED needs by and byLine"); continue; }
        if (WITNESSES.some(x => x.id === sw.id)) { errors.push(id + ": separating history " + sw.id + " must not be a gate witness"); continue; }
        if (sw.invariant !== r.predicate) { errors.push(id + ": separating history is for " + sw.invariant + ", not " + r.predicate); continue; }
        M.__setCM(""); const orig = run(r.predicate, { trace: sw.trace, settled: sw.settled } as never), cited = run(e.by, { trace: sw.trace, settled: sw.settled } as never);
        M.__setCM(id); const mut = run(r.predicate, { trace: sw.trace, settled: sw.settled } as never); M.__setCM("");
        const rj = (v: Verdict | "throw") => v === "throw" || !v.ok; // a throw counts as the mutant rejecting
        const differ = rj(orig) !== rj(mut), citedRejects = rejects(cited, e.by);
        proofs.push("separating proof " + id + " via " + sw.id + ": original " + (rj(orig) ? "REJECTS" : "accepts") + ", mutant " + (rj(mut) ? "REJECTS" : "accepts") + ", " + e.by + ":" + e.byLine + " " + (citedRejects ? "REJECTS" : "accepts") + " => " + (differ && citedRejects ? "PROVEN" : "NOT PROVEN"));
        if (!differ) errors.push(id + ": COMBINED separating history " + sw.id + " does not separate the clause (original and mutant agree)");
        if (!citedRejects) errors.push(id + ": COMBINED cited predicate " + e.by + " does not reject separating history " + sw.id);
        r.verdict = "EQUIVALENT"; r.killer = "COMBINED by " + e.by + ":" + e.byLine + " via " + sw.id; r.how = e.argument; (r as Row & { eq?: EqKind }).eq = "COMBINED";
        continue;
      }
      else { r.verdict = "EQUIVALENT"; r.killer = e.kind + (e.kind === "SHADOW" ? " (shadowed by line " + e.shadowedBy + ")" : ""); r.how = e.argument; (r as Row & { eq?: EqKind }).eq = e.kind; (r as Row & { shadowedBy?: number }).shadowedBy = e.shadowedBy; continue; }
    }
    if (strict) for (const r of rows) if (r.verdict === "SURVIVED") errors.push(r.id + ": survives (" + (r.dir ?? "?") + ") and has no verdict entry");
    const ms = Date.now() - t0;
    const count = (v: string) => rows.filter(r => r.verdict === v).length;
    const byPred: Record<string, number> = {};
    for (const r of rows.filter(x => x.verdict === "SURVIVED")) byPred[r.predicate] = (byPred[r.predicate] ?? 0) + 1;
    fs.writeFileSync(path.join(DIR, GROUP ? "results-" + GROUP + ".json" : "results.json"), JSON.stringify(rows, null, 1));
    const esc = (s: string) => s.replace(/\|/g, "\\|");
    const eqs = rows.filter(r => r.verdict === "EQUIVALENT");
    const eqOf = (r: Row) => (r as Row & { eq?: EqKind }).eq;
    const nk = (k: EqKind) => eqs.filter(r => eqOf(r) === k).length;
    const capLine = "equivalent by kind: NULL " + nk("NULL") + ", SHADOW " + nk("SHADOW") + ", COMBINED " + nk("COMBINED") + "; cap (NULL+COMBINED)/total clauses = " + (nk("NULL") + nk("COMBINED")) + "/" + rows.length + " = " + (rows.length ? (((nk("NULL") + nk("COMBINED")) / rows.length) * 100).toFixed(1) : "0") + "% (limit 10%)";
    const step3 = eqs.filter(r => eqOf(r) === "SHADOW").map(r => "STEP 3 REMOVE " + r.id + " line " + r.line + " (shadowed by line " + (r as Row & { shadowedBy?: number }).shadowedBy + "): " + r.text);
    const md = ["# CLAUSE-MUTANTS-" + (GROUP || "r34d"), "", ...(GROUP ? ["Group " + GROUP + ": " + groups[GROUP].join(", "), ""] : []), "Generated by `server/email/exec-spec/restore/clause-mutants/gen.mjs` + `clause-mutants.test.ts` (CM_RUN=1), spec `invariants.current.ts`, " + WITNESSES.length + " witnesses + combined gate (" + accepts.length + " must-accept x " + names.length + " predicates).",
      "", "Total " + rows.length + ": KILLED " + count("KILLED") + ", REDUNDANT (proven) " + count("REDUNDANT") + ", EQUIVALENT (argued, for review) " + count("EQUIVALENT") + ", SURVIVED " + count("SURVIVED") + ".", "",
      "Kinds: op = one operand of a top-level &&/|| chain removed (replaced by the chain identity); guard = an `if (...) return <violation>` / violation ternary removed; branch = an early-reject block skipped. A kill by `predicate threw` means the clause is a guard the rest of the body depends on.", "",
      ...(eqs.length ? ["EQUIVALENT clauses for review (" + capLine + "):", "", ...eqs.map(r => "- " + r.id + " [" + eqOf(r) + "] `" + r.text + "`: " + r.how), ""] : []), ...(step3.length ? ["STEP 3 REMOVE (duplicate same-predicate checks):", "", ...step3.map(x => "- " + x), ""] : []), ...(errors.length ? ["ERRORS:", "", ...errors.map(e => "- " + e), ""] : []), "Survivors by predicate: " + (Object.entries(byPred).map(([k, v]) => k + " " + v).join(", ") || "none"), "", ...proofs.map(p => "- " + p), "",
      "Survivors by direction: " + ["weaker", "stricter", "?"].map(d => d + " " + rows.filter(r => r.verdict === "SURVIVED" && (r.dir ?? "?") === d).length).join(", ") + " (weaker = removal only accepts more: needs a must-reject witness or a proven redundancy; stricter = removal only rejects more: needs a must-accept witness; ? = callback / initializer, not decidable from syntax).", "",
      "| id | kind | dir | line | clause | verdict | killing witness / redundancy proof |", "|---|---|---|---|---|---|---|",
      ...rows.map(r => "| " + r.id + " | " + r.kind + (r.chain ? " " + r.chain : "") + " | " + (r.dir ?? "?") + " | " + r.line + " | `" + esc(r.text) + "` | " + r.verdict + " | " + esc(r.killer + (r.how ? " (" + r.how + ")" : "")) + " |")];
    fs.writeFileSync(process.env.CM_MD ?? (GROUP ? path.join(__dirname, "../../../..", "CLAUSE-MUTANTS-" + GROUP + ".md") : path.join(DIR, "CLAUSE-MUTANTS-r34d.md")), md.join("\n") + "\n");
    console.log("clause mutants: " + rows.length + " total, KILLED " + count("KILLED") + ", REDUNDANT " + count("REDUNDANT") + ", EQUIVALENT " + count("EQUIVALENT") + ", SURVIVED " + count("SURVIVED") + " in " + ms + " ms");
    console.log(capLine);
    for (const x of step3) console.log(x);
    console.log("clause survivors by predicate: " + JSON.stringify(byPred));
    console.log("clause survivors by direction: " + ["weaker", "stricter", "?"].map(d => d + " " + rows.filter(r => r.verdict === "SURVIVED" && (r.dir ?? "?") === d).length).join(", "));
    for (const p of proofs) console.log(p);
    expect(rows.length).toBe(clauses.length);
    expect(errors).toEqual([]);
  }, 3_600_000);
});

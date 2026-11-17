// SPDX-License-Identifier: AGPL-3.0-or-later
// D6 P2/P4/P5b: every assignment form that can rebind an audited binding is RED by assertion (the guard names the violation). One table per form;
// each snippet is appended to the exporter (admission-shared.ts) and to the importer (wal-maintenance.ts) and must be reported in both.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { GUARD_FILES, walGuard, type GuardSources } from "./testing/wal-guard.ts";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const real = Object.fromEntries(GUARD_FILES.map(f => [f, readFileSync(join(repo, f), "utf8")])) as GuardSources;
type F = (typeof GUARD_FILES)[number];
const AS = "server/admission-shared.ts", WM = "server/wal-maintenance.ts", IM = "server/io-meter.ts";

/** Each form lists snippets over the placeholder `L`, replaced by the audited name. Every snippet must trigger the "reassigns/assigned" violation. */
const FORMS: Record<string, string[]> = {
  "array destructuring": ["[L] = [L.bind(null)];", "[L, other] = [1, 2];", "[other, L] = [1, 2];", "[, , L] = [1, 2, 3];"],
  "nested array destructuring": ["[[L]] = [[L.bind(null)]];", "[[[L]]] = [[[L.bind(null)]]];", "[{ a: [L] }] = [{ a: [1] }];"],
  "array destructuring default": ["[L = L.bind(null)] = [];", "[[L = 1]] = [[]];"],
  "array rest": ["[...L] = [1, 2];", "[first, ...L] = [1, 2];", "[[...L]] = [[1]];"],
  "object destructuring": ["({ a: L } = { a: 1 });", "({ L } = { L: 1 });", "({ a: other, b: L } = { a: 1, b: 2 });"],
  "nested object destructuring": ["({ a: { b: L } } = { a: { b: 1 } });", "({ a: [L] } = { a: [1] });", "[{ a: L }] = [{ a: 1 }];"],
  "object destructuring default": ["({ L = L.bind(null) } = {});", "({ a: L = 1 } = {});"],
  "object rest": ["({ ...L } = { a: 1 });", "({ a, ...L } = { a: 1, b: 2 });"],
  "compound assignment": ["L += 1;", "L ||= (() => 0) as never;", "L &&= (() => 0) as never;", "L ??= (() => 0) as never;", "L **= 2;", "L >>>= 1;"],
  "update expression": ["L++;", "L--;", "++L;", "--L;"],
  "parenthesized or wrapped target": ["(L) = (() => 0) as never;", "((L)) += 1;", "(L)++;", "--(L);", "(L as never) = (() => 0) as never;", "(L!) = (() => 0) as never;", "(L satisfies never) = (() => 0) as never;", "(<never>L) = (() => 0) as never;", "[(L)] = [1];", "({ a: (L) } = { a: 1 });", "[L as never] = [1];", "({ a: L! } = { a: 1 });"],
  "comma target": ["(0, L)++;", "(0, L) = (() => 0) as never;", "(0, L) += 1;"],
  "for-in head": ["for (L in { a: 1 }) {}", "for ((L) in { a: 1 }) {}", "for ([L] in { a: 1 }) {}", "for ({ L } in { a: 1 }) {}"],
  "for-of head": ["for (L of [1]) {}", "for ((L) of [1]) {}", "for ([L] of [[1]]) {}", "for ({ L } of [{ L: 1 }]) {}", "for ({ a: [L] } of [{ a: [1] }]) {}", "for ([...L] of [[1]]) {}", "for ([L = 1] of [[]]) {}"],
  "property write on a holder": ["ns.L = (() => 0) as never;", 'ns["L"] = (() => 0) as never;', "ns[`L`] = (() => 0) as never;", "exports.L = (() => 0) as never;", "module.exports.L = (() => 0) as never;", "holder.L ||= (() => 0) as never;", "holder.L++;", "[ns.L] = [1];", "({ a: ns.L } = { a: 1 });", "for (ns.L of [1]) {}", "delete ns.L;", 'delete ns["L"];'],
  "Object.assign": ["Object.assign(ns, { L: (() => 0) as never });", 'Object.assign(holder, { ["L"]: 1 });', 'Object.assign(holder, { "L": 1 });', "Object.assign(holder, { L });", "Object.assign(ns, patch);", "Object.assign(exports, patch);", "Object.assign(module.exports, patch);", "Object.assign(globalThis, patch);", 'import dflt from "./x.ts"; Object.assign(dflt, patch);', 'import eq = require("./x.ts"); Object.assign(eq, patch);', "Object.assign(ns.sub, patch);"],
  "Object.defineProperty": ['Object.defineProperty(ns, "L", { value: 1 });', "Object.defineProperty(holder, `L`, { get: () => 1 });", "Object.defineProperty(ns, key, { value: 1 });", 'Object.defineProperties(holder, { L: { value: 1 } });', 'Object.defineProperties(ns, descriptors);'],
  "Reflect": ['Reflect.set(ns, "L", 1);', "Reflect.set(holder, `L`, 1);", 'Reflect.defineProperty(ns, "L", { value: 1 });', 'Reflect.deleteProperty(holder, "L");', "Reflect.set(ns, key, 1);", "Reflect.set(exports, key, 1);"],
};
/** Preamble giving the snippets a namespace import to write through (as a holder reachable in this file). */
const NS = (f: F) => (f === AS ? 'import * as ns from "./other-module.ts";\n' : 'import * as ns from "./admission-shared.ts";\n');
const NAME: Record<string, { file: F; name: string; msg: RegExp }[]> = {
  "": [
    { file: AS, name: "checkpointLedger", msg: /P2: admission-shared\.ts reassigns/ },
    { file: WM, name: "checkpointLedger", msg: /P2: checkpointLedger is shadowed or assigned in wal-maintenance\.ts/ },
    { file: IM, name: "ioMeterNativePath", msg: /P4: io-meter\.ts reassigns/ },
  ],
};

for (const [form, snippets] of Object.entries(FORMS))
  for (const { file, name, msg } of NAME[""]!)
    for (const s of snippets) {
      // `L` is a placeholder token; `ns`, `holder`, `key`, `patch`, `descriptors` are free names in the appended statement (the guard reads syntax, not types)
      const body = s.replace(/\bL\b/g, name);
      it(`RED by assertion: ${form}: ${file.slice(7)}: ${body}`, () => {
        const sources = { ...real, [file]: NS(file) + real[file] + "\n" + body + "\n" } as GuardSources;
        const violations = walGuard(sources);
        expect(violations.length, `the guard missed (${form}): ${body}`).toBeGreaterThan(0);
        expect(violations.join("\n")).toMatch(msg);
      });
    }

it("declaring the audited names legitimately still reports nothing (no false positive on reads, calls, bindings)", () => {
  const reads = [
    "const read = checkpointLedger.toString();", "const bound = checkpointLedger.bind(null);", "const r = [checkpointLedger];", "const o = { checkpointLedger };", "const o2 = { a: checkpointLedger };",
    "const cmp = checkpointLedger === undefined || !checkpointLedger || -checkpointLedger || typeof checkpointLedger;", "for (const x of [checkpointLedger]) { void x; }", "for (const k in { checkpointLedger }) { void k; }",
    "const [first] = [checkpointLedger];", "const { length } = checkpointLedger;", "void checkpointLedger.name; void ns.checkpointLedger; void ns['checkpointLedger'];", "Object.assign({}, { x: checkpointLedger });",
    "Object.defineProperty(local, 'other', { value: checkpointLedger });", "Reflect.set(local, 'other', checkpointLedger);", "Object.assign(local, patch);", "Object.freeze(checkpointLedger);",
    "let other = 0; other += 1; other++; [other] = [1]; ({ other } = { other: 2 }); for (other of [1]) {}", "const holder = { checkpointLedger: 1 }; void holder;",
  ];
  for (const file of [AS, WM] as F[]) for (const r of reads) {
    const violations = walGuard({ ...real, [file]: (file === AS ? 'import * as ns from "./other-module.ts";\n' : 'import * as ns from "./admission-shared.ts";\n') + real[file] + "\n" + r + "\n" } as GuardSources);
    expect(violations.filter(v => /reassigns|assigned in/.test(v)), `false positive on: ${r}`).toEqual([]);
  }
});

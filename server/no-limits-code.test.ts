// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PyReader } from "./no-limits-python.ts";
import * as bounds from "./no-limits-budget.ts";
import { judge, noLimitsCode } from "./no-limits-code.ts";
import { atLeastAsStrict } from "./testing/no-limits-parity.ts";

// Byte-identical executable specification. Never regenerate expectations from the port.
const bytes = readFileSync(new URL("./testing/fixtures/no-limits-r12/judge_expected.tsv", import.meta.url));
const faultBytes = readFileSync(new URL("./testing/fixtures/no-limits-r12/judge_faults.json", import.meta.url));
const faults: Record<string, string> = JSON.parse(faultBytes.toString("utf8"));
const rows = bytes.toString("utf8").trimEnd().split("\n").slice(1).map(line => {
  const [id, identity, mode, payload, expected, reason] = line.split("\t");
  return { id, identity, mode, payload: JSON.parse(payload) as unknown, expected, reason };
});
it("pins the r1.2.1 corpus bytes and row count", () => {
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("443a92088c59780f79dbfa12f226a72eccbaf355d98ba7a738f8074236a55611");
  expect(rows).toHaveLength(141);
  expect(createHash("sha256").update(faultBytes).digest("hex")).toBe("f42a44f212f2fd71b45c6d7613eccedcfc5ac5854e83a4e9c1138f06e76a0133");
  const reference = readFileSync(new URL("./testing/fixtures/no-limits-r12/judge.py", import.meta.url));
  expect(createHash("sha256").update(reference).digest("hex")).toBe("b3d3459fe2882acd760bd29a3596fdf6a3acf3cbd3bbcd1068fb03d06acb524f");
});
describe("r1.2.1 judge.py port parity", () => {
  const comparisons: { id: string; expected: string; actual: string }[] = [];
  afterAll(() => {
    // MAIN r1.3a: record every allowed over-strict row without changing the oracle.
    const overStrict = comparisons.filter(row => row.actual !== row.expected && atLeastAsStrict(row.actual, row.expected));
    const report = process.env.TOOLID_PARITY_REPORT;
    if (report) writeFileSync(report, JSON.stringify({
      compared: comparisons.length,
      looser_count: comparisons.filter(row => !atLeastAsStrict(row.actual, row.expected)).length,
      count: overStrict.length,
      rows: overStrict.sort((a, b) => a.id.localeCompare(b.id)),
    }, null, 2) + "\n");
  });
  it.each(rows)("$id ($expected): $reason", ({ id, identity, payload, mode, expected }) => {
    const fault = faults[id];
    // Same checker-side faults as reader_faults.py; never payload directives.
    if (fault === "after-twin") {
      const original = PyReader.prototype.twinDelete;
      vi.spyOn(PyReader.prototype, "twinDelete").mockImplementation(function(this: PyReader, ...args) {
        original.apply(this, args);
        throw new Error("injected after collecting twin, during AST walk");
      });
    } else if (fault === "before-walk" || fault === "recursion") {
      vi.spyOn(PyReader.prototype, "run").mockImplementation(() => {
        throw fault === "recursion" ? new RangeError("injected recursion limit") : new Error("injected mid-reader");
      });
    } else if (fault === "size") {
      vi.spyOn(bounds, "boundedText").mockImplementation(() => { throw new bounds.ReaderCut("injected size limit"); });
    } else if (fault === "work") {
      vi.spyOn(bounds.ReaderBudget.prototype, "tick").mockImplementation(() => { throw new bounds.ReaderCut("injected work limit"); });
    } else expect(fault).toBeUndefined();
    try {
      const actual = judge(identity, payload, mode);
      const verdict = actual.verdict + (actual.cls ? ":" + actual.cls : "");
      comparisons.push({ id, expected, actual: verdict });
      expect(atLeastAsStrict(verdict, expected), `${id}: ${verdict} must be at least as strict as ${expected}`).toBe(true);
    } finally { vi.restoreAllMocks(); }
  });
});

describe("approval adapter and input boundaries", () => {
  it.each([
    ["rm -rf /", "delete-root"], ["rm -rf ~", "delete-home"],
    ["rm -rf /etc", "delete-system-folder"], ["mkfs.ext4 /dev/sda", "disk-erase"],
    [":(){ :|:& };:", "fork-bomb"], ["rm -rf build", "plainWipe"],
  ])("maps %s to %s", (text, cls) => expect(noLimitsCode("terminal", text).cls).toBe(cls));
  it("maps truncation before reading payloads", () => {
    expect(noLimitsCode("python", "print(1)", "nl-cut").cls).toBe("truncated");
  });
  it("rejects modes outside this reader's policy", () => {
    expect(() => judge("terminal", "ls", "full")).toThrow("owner No-limits");
  });
  it("does not inherit a payload language from Object.prototype", () => {
    expect(judge("constructor", { text: "delete the draft" }).verdict).toBe("run");
  });
  it("terminates cyclic object inputs without losing their string leaves", () => {
    const input: Record<string, unknown> = { text: "rm -rf /" }; input.self = input;
    expect(judge("mcp__s__note", input).cls).toBe("root");
  });
  it("keeps non-code commandArgument precedence and reads remaining leaves as text", () => {
    expect(judge("mcp__s__run", { command: "ls", cmd: "rm -rf build" }).verdict).toBe("run");
    expect(judge("mcp__s__run", { command: "ls", cmd: "rm -rf /" }).cls).toBe("root");
  });
});

it("preserves an explicit dotted import alias even when it equals the top-level module", () => {
  expect(judge("python", "import os.path as os; import shutil; shutil.rmtree(os.join('/', 'etc'))").cls).toBe("system");
});

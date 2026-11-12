// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PyReader } from "./no-limits-python.ts";
import * as bounds from "./no-limits-budget.ts";
import { judge, noLimitsCode, CODE_CLASS_MAPPING } from "./no-limits-code.ts";
import { atLeastAsStrict } from "./testing/no-limits-parity.ts";

// Byte-identical executable specification. Never regenerate expectations from the port.
const bytes = readFileSync(new URL("./testing/fixtures/no-limits-r12/reader_expected.tsv", import.meta.url));
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
function injectCorpusFault(id: string) {
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
}
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
    injectCorpusFault(id);
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

// The historical reader may report word/cut. Those observations are not
// permission: the current owner policy must match Sean's ruling exactly.
import {autoVerdict} from './auto-approve.ts';
const policyRows = readFileSync(new URL('./testing/fixtures/no-limits-r12/judge_expected.tsv',import.meta.url),'utf8').trimEnd().split('\n').slice(1).map(line=>{
 const [id,identity,mode,payload,expected,reason]=line.split('\t');return {id,identity,mode,payload:JSON.parse(payload),expected,reason};
});
const rejudged = new Set(["W6", "W9", "P1code", "P1sh", "P2code", "P2sh", "P3code", "P3sh", "A1py", "A1js", "A1sh", "A1pathlib", "A1unlinkJs", "A1rmSyncFile", "A1dyn", "A1dynJs", "A1twoLevel", "A1reassigned", "S3", "S6", "S11", "H8py", "M2", "R121-bytes-escape", "R121-strip", "R121-slashes-80", "R121-slashes-10000", "R121-megabyte", "R121-exception-empty", "R121-exception-word", "R121-recursion", "R121-size", "R121-work", "R121-parser-depth"]);
it.each(policyRows.filter(row=>rejudged.has(row.id)))('current No limits policy $id: $reason',row=>{
 const native = ['python','execute_code','node'].includes(row.identity);
 const tool=native?row.identity:row.identity==='terminal'?'Bash':row.identity;
 const input=native?{code:row.payload}:typeof row.payload==='string'?{command:row.payload}:row.payload;
 const command=tool==='Bash'?row.payload:undefined;
 const context={fullAccessOrigin:'owner' as const,ownerStarted:true,outsideRead:null,commandText:command,commandCwd:'/work',inputTruncated:row.mode==='nl-cut',call:{tool,toolCall:{name:tool,input}}};
 injectCorpusFault(row.id);
 try {
 const actual=autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},tool,typeof row.payload==='string'?row.payload:JSON.stringify(row.payload),context);
 if(row.expected==='run')expect(actual).toMatchObject({approve:`auto-approved ${tool} (no limits)`,source:'no-limits'});
 else expect(actual).toMatchObject({approve:null,rule:CODE_CLASS_MAPPING[row.expected.split(':')[1] as keyof typeof CODE_CLASS_MAPPING]});
 } finally { vi.restoreAllMocks(); }
});

it.each(["import shutil; shutil.rmtree('/')","import shutil; p = '/'; shutil.rmtree(p)"])(
 'current No limits policy keeps the resolved root wipe: %s',code=>{
 const tool='python';
 const actual=autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},tool,code,{fullAccessOrigin:'owner',ownerStarted:true,outsideRead:null,call:{toolCall:{name:tool,input:{code}}}});
 expect(actual).toMatchObject({approve:null,rule:'delete-root'});
});

it('current No limits policy runs the temporary-folder git clean twin',()=>{
 const command='git clean -fdx';
 expect(autoVerdict({autoApprove:true,fullAccess:true,noLimits:true},'Bash',command,{fullAccessOrigin:'owner',ownerStarted:true,outsideRead:null,commandText:command,commandCwd:'/tmp/murage-clean-fixture'})).toMatchObject({approve:'auto-approved Bash (no limits)',source:'no-limits'});
});

// Retain the rows lane's independent wipe-reader checks as well as approval
// delivery checks above. The reader oracle remains the separate frozen file.
import {noLimitsWipe} from './no-limits-wipe.ts';
const historicalExpected=new Map(rows.map(row=>[row.id,row.expected]));
it.each(policyRows.filter(row=>row.expected!==historicalExpected.get(row.id)))('R5 R6 product $id expects $expected',row=>{
 const lang=/^(?:execute_code|python|py)$/.test(row.identity)?'py':row.identity==='node'?'js':'sh';
 const payload=row.payload as any;
 const text=typeof payload==='string'?payload:typeof payload?.command==='string'&&payload.command.trim()?payload.command:payload?.cmd??'';
 const hit=noLimitsWipe(text,{lang,unread:row.mode==='nl-cut'});
 const cls:Record<string,string>={'delete-root':'root','delete-home':'home','delete-system-folder':'system','disk-erase':'disk','fork-bomb':'fork'};
 expect(hit?'card:'+cls[hit.rule]:'run',row.reason).toBe(row.expected);
});

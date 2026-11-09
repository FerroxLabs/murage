// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S4-INTERP-NOLIMITS (1.0.18, designs/S4-INTERP-NOLIMITS-RULING-1018.md section 5): `node -e 1` and `python3 -c 1` name no function,
// module, file or socket, so they read nothing and carry no `interpreter` mark. Every other inline code still marks. Rows I1-I11,
// one mutant each. Fixture strings are inert data, never executed.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoVerdict, type AutoContext } from "./auto-approve.ts";
import { SESSION_EDITS_OVERFLOW, beginOutsideTurn, forgetOutsideState, sessionEdits, turnOutsideRead, wireOutsideStore } from "./email/external-marks.ts";
import { outsideScanMarks, type OutsideScanHooks } from "./outside-scan.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { markCallOutside, noteToolStartOutside, outsideContextFields, toolStartOutside, type ToolStart } from "./outside-wire.ts";

const STARTUP = /^(?:sitecustomize|usercustomize)(?:\.pyc?)?$/;
/** node and python3 resolve under /usr/bin (a system root); no startup file exists unless `extra` names one. */
const clean = (extra: readonly string[] = []): OutsideScanHooks => ({
  cwd: "/w", home: "/h", lookupProgram: (name) => `/usr/bin/${name}`,
  probe: (p) => (extra.includes(p) || !(STARTUP.test(p.slice(p.lastIndexOf("/") + 1))) ? { kind: "file", real: p, fresh: false, zip: false } : null),
});
const marks = (text: string, hooks: OutsideScanHooks = clean()) => outsideScanMarks(text, hooks);

describe("I1 inert numeric inline code reads nothing", () => {
  it.each(["node -e 1", "node -p 1+1", "python3 -c 1"])("I1 %s carries no mark", (text) => expect(marks(text), text).toEqual([]));
});

describe("I2 real inline code still marks", () => {
  it.each(["node -e fetch(1)", "node -e require", "python3 -c print(1)"])("I2 %s", (text) => expect(marks(text), text).toContain("interpreter"));
});

// Fable L2 (11-08): spellings that are not exactly `<flag> <digit word>` still mark
describe("I2b flag and code spellings that are not the accepted shape", () => {
  it.each(["node -e1", "node --eval=1", "node -pe 1", "node -e \"1;fetch(1)\"", "node -e 1e9", "node -e 0x1"])("I2b %s", (text) => expect(marks(text), text).toContain("interpreter"));
});

describe("I3 a word after the code still marks", () => {
  it("I3 node -e 1 x.js", () => expect(marks("node -e 1 x.js")).toContain("interpreter"));
});

describe("I4 the flag must lead", () => {
  it.each(["node --require ./x.js -e 1", "node --inspect -e 1"])("I4 %s", (text) => expect(marks(text), text).toContain("interpreter"));
  // `node x -e 1` is a script run (script `x`, operands `-e 1`), unmarked on 5c74134bc too: this fix leaves it as it was
  it("I4b node x -e 1 is read as a script run, as before", () => expect(marks("node x -e 1")).toEqual([]));
});

describe("I5 the code word starts with a digit", () => {
  it.each(["node -e -1", "node -e .5", "node -e --require=/w/x.js"])("I5 %s", (text) => expect(marks(text), text).toContain("interpreter"));
});

describe("I6 only node and python are accepted", () => {
  it.each(["ruby -e 1", "bun -e 1", "deno eval 1", "pwsh -c 1", "julia -e 1", "perl -e 1"])("I6 %s", (text) => expect(marks(text), text).toContain("interpreter"));
});

describe("I7 python still reads its startup files", () => {
  it("I7 python3 -c 1 marks when sitecustomize sits in the working folder", () => {
    expect(marks("python3 -c 1", clean(["/w/sitecustomize.py"]))).toContain("interpreter");
    expect(marks("python3 -c 1", clean())).toEqual([]);
  });
});

describe("I8 the env rules still run", () => {
  it("I8 a prefix assignment and an engine started with a deny variable still mark", () => {
    expect(marks("NODE_OPTIONS=--require=/w/x.js node -e 1")).toContain("interpreter");
    expect(marks("node -e 1", { ...clean(), engineEnv: true })).toContain("interpreter");
  });
});

describe("I9 quoted code still marks", () => {
  it("I9 node -e \"1\"", () => expect(marks("node -e \"1\"")).toContain("interpreter"));
});

// MurageMain ruling (11-08, Astra r1 High): inert code is inert only when the interpreter is the real one. The resolver is the one
// runnerResolves uses (lookupProgram, then probe): a regular file, not written this turn, realpath under SYSTEM_ROOTS.
describe("I12 a non-system node or python on PATH marks", () => {
  it.each(["node -e 1", "python3 -c 1"])("I12 %s resolving to an old wrapper under /w/bin", (text) => {
    const hooks: OutsideScanHooks = { ...clean(), lookupProgram: (name) => `/w/bin/${name}` };
    expect(marks(text, hooks), text).toContain("interpreter");
    expect(marks(text), text).toEqual([]);
  });
});

describe("I13 an unknown lookup marks", () => {
  it.each([null, undefined])("I13 lookup answers %s", (answer) => {
    expect(marks("node -e 1", { ...clean(), lookupProgram: () => answer })).toContain("interpreter");
  });
  it("I13b no PATH lookup or no disk probe marks", () => {
    const { lookupProgram: _l, ...noLookup } = clean();
    const { probe: _p, ...noProbe } = clean();
    expect(marks("node -e 1", noLookup)).toContain("interpreter");
    expect(marks("node -e 1", noProbe)).toContain("interpreter");
  });
});

// Astra r2 Medium: a hook that scans while the identity check runs must not erase the pending names of the outer scan
describe("I16 a nested scan inside a hook leaves the outer identity check intact", () => {
  it("I16 old wrapper node, probe getter scans echo 1", () => {
    const hooks: OutsideScanHooks = {
      cwd: "/w", lookupProgram: (name) => `/w/bin/${name}`,
      get probe() {
        outsideScanMarks("echo 1", {});
        return (p: string) => ({ kind: "file" as const, real: p, fresh: false, zip: false });
      },
    };
    expect(outsideScanMarks("node -e 1", hooks)).toContain("interpreter");
  });
});

describe("I14 a node written this turn marks", () => {
  it("I14 fresh /usr/bin/node", () => {
    const base = clean();
    expect(marks("node -e 1", { ...base, probe: (p) => { const hit = base.probe!(p, false); return hit && p === "/usr/bin/node" ? { ...hit, fresh: true } : hit; } })).toContain("interpreter");
    expect(marks("node -e 1", { ...base, sessionEdits: new Set(["/usr/bin/node"]) })).toContain("interpreter");
  });
});

// Fable Low 1 (S4-INTERP): the edit set is checked against the realpath too. The symlink target is OLD (fresh: false), so only
// sessionEdits can catch it; the PATH name /usr/bin/node itself is not in the set.
describe("I17 an interpreter edited through its realpath is not exempt", () => {
  const linked = (real: string, edits: readonly string[]): OutsideScanHooks => ({
    ...clean(), sessionEdits: new Set(edits),
    probe: (p) => (p === "/usr/bin/node" || p === "/usr/bin/python3" ? { kind: "file", real, fresh: false, zip: false } : { kind: "file", real: p, fresh: false, zip: false }),
  });
  it("I17 node -e 1 through a symlink whose old realpath was edited this turn marks", () => {
    const real = "/opt/homebrew/Cellar/node/9.9/bin/node";
    expect(marks("node -e 1", linked(real, [real]))).toContain("interpreter");
    expect(marks("node -e 1", linked(real, []))).toEqual([]);
  });
  it("I17b runnerResolves: the same symlinked program run by name marks", () => {
    const real = "/opt/homebrew/Cellar/node/9.9/bin/node";
    expect(marks("node x.js", linked(real, [real]))).toContain("interpreter");
    expect(marks("node x.js", linked(real, []))).toEqual([]);
  });
});

describe("I15 the name is spelled in lower case only", () => {
  it.each(["NODE -e 1", "Node -p 1+1", "PYTHON3 -c 1"])("I15 %s", (text) => expect(marks(text), text).toContain("interpreter"));
  it("I15b a path-spelled interpreter is judged as before", () => {
    for (const text of ["./node -e 1", "/w/bin/node -e 1"]) expect(marks(text), text).toContain("interpreter");
  });
});

describe("I10 and I11 the chat stays clean after node -e 1, and is marked after real inline code", () => {
  afterEach(() => forgetOutsideState());
  const NL = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
  const wire = () => { wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "s4-inert-")), "s.jsonl"))); beginOutsideTurn("t1", "i1", "turn-1", false); };
  const call = (command: string, callKey: string): ToolStart => ({ origin: "engine", title: "Bash", callKey, input: { command } });
  const start = (item: ToolStart) => {
    const source = toolStartOutside(item, undefined, { scan: clean() });
    if (source) markCallOutside("t1", source, item);
  };
  const verdict = (command: string, key: string) => autoVerdict(NL as never, "Bash", command, {
    fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, commandText: command, commandCwd: "/w", workFolder: "/w",
    ...outsideContextFields("t1", "/w", { key }),
  } as unknown as AutoContext);

  it("I10 node -e 1 runs with no card, and the next turn `mkdir -p tmp/out` runs with no card", () => {
    wire();
    start(call("node -e 1", "k1"));
    expect(turnOutsideRead("t1")).toBeNull();
    expect(verdict("node -e 1", "k1").source).not.toBe("outside-turn");
    expect(verdict("node -e 1", "k1").approve).toBeTruthy();
    beginOutsideTurn("t1", "i1", "turn-2", true);
    expect(turnOutsideRead("t1")).toBeNull();
    const next = verdict("mkdir -p tmp/out", "k2");
    expect(next.source).not.toBe("outside-turn");
    expect(next.approve).toBeTruthy();
  });

  it("I11 real inline code cards on the call, and the next turn cards `earlier turn`", () => {
    wire();
    const text = "node -e require(\"os\").cpus()";
    start(call(text, "k1"));
    expect(turnOutsideRead("t1")).toBe("interpreter");
    expect(verdict(text, "k1").approve).toBeNull();
    beginOutsideTurn("t1", "i1", "turn-2", true);
    expect(turnOutsideRead("t1")).toBe("earlier turn");
    expect(verdict("mkdir -p tmp/out", "k2")).toMatchObject({ approve: null, source: "outside-turn" });
  });
});

// Fable (S4-INTERP-L1): the producer holds every spelling of an edited path, so an edit through a symlink or a non-normalized
// spelling is matched by a later run of the same file under another spelling, whatever the file's age.
describe("I18 an edit is held under its normalized and real spellings", () => {
  afterEach(() => forgetOutsideState());
  const wire = () => { wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "s4-spell-")), "s.jsonl"))); beginOutsideTurn("t1", "i1", "turn-1", false); };
  const edit = (file: string) => { noteToolStartOutside("t1", { origin: "engine", title: "Write", callKey: `w-${file}`, input: { file_path: file } }, "/w"); };
  const later = (command: string) => {
    beginOutsideTurn("t1", "i1", "turn-2", true);
    return outsideScanMarks(command, { ...clean(), sessionEdits: sessionEdits("t1", "i1") });
  };
  it("I18a an earlier-turn edit through a symlink, then a run of the real path with an old mtime, marks", () => {
    wire();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "s4-link-")));
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    writeFileSync(join(root, "real", "tool"), "x");
    utimesSync(join(root, "real", "tool"), new Date(1e12), new Date(1e12));
    edit(join(root, "link", "tool"));
    expect(later(join(root, "real", "tool"))).toContain("interpreter");
    expect(outsideScanMarks(join(root, "real", "tool"), { ...clean(), sessionEdits: new Set(["/w/other"]) })).toEqual([]);
  });
  it("I18c a missing file under a symlink followed by .. is held at its real place", () => {
    wire();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "s4-dots-")));
    mkdirSync(join(root, "w")); mkdirSync(join(root, "other")); mkdirSync(join(root, "other", "sub"));
    symlinkSync(join(root, "other", "sub"), join(root, "w", "link"));
    edit(`${root}/w/link/../newtool`);
    expect(later(join(root, "other", "newtool"))).toContain("interpreter");
  });
  it("I18d a write under a missing parent, reached later through a symlinked ancestor, marks", () => {
    wire();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "s4-missing-")));
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    edit(join(root, "link", "newdir", "deep", "tool"));
    expect(later(join(root, "real", "newdir", "deep", "tool"))).toContain("interpreter");
  });
  const editInput = (input: Record<string, string>) => { noteToolStartOutside("t1", { origin: "engine", title: "Write", callKey: "w-many", input }, "/w"); };
  // /…/link -> /…/real; a deep missing path under `link` costs 31 realpath attempts and is held at its real place
  const rig = () => {
    wire();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "s4-budget-")));
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    const lex = (name: string) => `${root}/link/${"a/".repeat(30)}${name}`;
    const real = (name: string) => `${root}/real/${"a/".repeat(30)}${name}`;
    return { lex, real };
  };
  it("I18e one call that repeats a path looks it up once, so the next path still gets its realpath", () => {
    const { lex, real } = rig();
    editInput({ file_path: lex("f1"), path: lex("f1"), notebook_path: lex("f2") });
    expect(sessionEdits("t1", "i1").has(real("f2"))).toBe(true);
  });
  it("I18f past the call's realpath budget every path is still held under its own spelling, with no overflow", () => {
    const { lex, real } = rig();
    editInput({ file_path: lex("f1"), path: lex("f2"), notebook_path: lex("f3"), filePath: lex("f4") });
    const edits = sessionEdits("t1", "i1");
    for (const n of ["f1", "f2", "f3", "f4"]) expect(edits.has(lex(n)), n).toBe(true);
    expect(edits.has(SESSION_EDITS_OVERFLOW)).toBe(false);
    expect(edits.has(real("f1"))).toBe(true);
    expect(edits.has(real("f4"))).toBe(false);
  });
  it("I18g extra spellings do not bring the session to its cap sooner than the same paths did before", () => {
    wire();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "s4-cap-")));
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    // 1400 paths x 3 spellings = 4200 entries: past the old cap of 4096 entries, far under 4096 paths
    for (let i = 0; i < 1400; i++) editInput({ file_path: `${root}/./link/f${i}` });
    editInput({ file_path: "/w/tool" });
    const edits = sessionEdits("t1", "i1");
    expect(edits.has(SESSION_EDITS_OVERFLOW)).toBe(false);
    expect(edits.has("/w/tool")).toBe(true);
  });
  it("I18g2 4096 paths with three spellings each fill the cap exactly with no overflow, the 4097th path overflows (Astra L1 r7)", () => {
    wire();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "s4-capx-")));
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    for (let i = 0; i < 4096; i++) editInput({ file_path: `${root}/./link/f${i}` });
    expect(sessionEdits("t1", "i1").size).toBe(4096 * 3);
    expect(sessionEdits("t1", "i1").has(SESSION_EDITS_OVERFLOW)).toBe(false);
    // every spelling already held: nothing is added and nothing overflows, even at exactly the cap
    editInput({ file_path: `${root}/./link/f0` });
    expect(sessionEdits("t1", "i1").size).toBe(4096 * 3);
    expect(sessionEdits("t1", "i1").has(SESSION_EDITS_OVERFLOW)).toBe(false);
    editInput({ file_path: `${root}/./link/f-past` });
    expect(sessionEdits("t1", "i1").has(SESSION_EDITS_OVERFLOW)).toBe(true);
  }, 60_000);
  it("I18b a non-normalized spelling edited, then the normalized path run, marks", () => {
    wire();
    edit("/w/./x/../tool");
    expect([...sessionEdits("t1", "i1")]).toContain("/w/tool");
    expect(later("/w/tool")).toContain("interpreter");
  });
});

// Fable Low A (L1): a script operand spelled in another case (or through a link) is judged by its realpath against the edit set.
describe("I19 a script operand edited earlier under another spelling marks", () => {
  it("I19 node /w/x.js after /w/X.js was edited (the scan folds case; the probe reports the real case, an old file)", () => {
    const hooks: OutsideScanHooks = {
      ...clean(), sessionEdits: new Set(["/w/X.js"]),
      probe: (p) => ({ kind: "file", real: p.toLowerCase() === "/w/x.js" ? "/w/X.js" : p, fresh: false, zip: false }),
    };
    expect(outsideScanMarks("node /w/x.js", hooks)).toContain("interpreter");
    expect(outsideScanMarks("node /w/y.js", hooks)).toEqual([]);
  });
});

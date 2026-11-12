// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NL-WIN-1018 (designs/NL-WIN-1018.md r2.1): No limits still carded `bash ./build.sh` on the owner's own clean turn.
//   D1  value-free first-mark provenance (a fixed site name, never a path value, argument or text)
//   D4  Windows pwsh: the exact `bash|sh <dir>/<name>.sh` text runs in owner mode (and, WIN-PWSH-1018, at Full access as the Claude
//       Bash tool's own text does: server/win-pwsh-1018.test.ts); every other spelling and level cards
//   D5  walk.ts: `-o <set-option name>` in a shell's -c form is not an output file (restores the shipped 1.0.17 verdict, gc-13)
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoVerdict } from "./auto-approve.ts";
import { expectNoLimitsOwnerOutcome } from "./testing/no-limits-1019.ts";
import { beginOutsideTurn, forgetOutsideState, markTurnOutside, safeMarkSite, turnOutsideRead, wireOutsideStore } from "./email/external-marks.ts";
import { fileOutsideStore } from "./outside-store.ts";
import { ownSite, ownToolGate, ownToolOfRoute } from "./outside-own.ts";

type Context = Parameters<typeof autoVerdict>[3];
const NO_LIMITS = { id: "owned", autoApprove: true, fullAccess: true, noLimits: true };
const FULL = { id: "full", autoApprove: true, fullAccess: true };
const AUTO = { id: "auto", autoApprove: true };
const ASK = { id: "ask" };

function wire(): void {
  expect(wireOutsideStore(fileOutsideStore(join(mkdtempSync(join(tmpdir(), "nlwin-store-")), "outside-state.jsonl")), () => 0)).toBe(true);
}

describe("NL-WIN-1018 D1: value-free first-mark provenance", () => {
  afterEach(() => { forgetOutsideState(); vi.restoreAllMocks(); });
  const logged = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.startsWith("outside: first-mark"));
  it("logs the first mark once, with the fixed site, thread and source only", () => {
    wire();
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    beginOutsideTurn("t1", "i", undefined, false);
    markTurnOutside("t1", "outside tool", undefined, undefined, "turn-start:carried");
    markTurnOutside("t1", "web page", undefined, undefined, "item:web page");
    expect(logged(spy)).toEqual(["outside: first-mark thread=t1 source=outside tool site=turn-start:carried"]);
  });
  it("Astra 3: a tool name built from a request path never reaches the log", () => {
    const tool = ownToolOfRoute("POST", "/api/internal/email/customer-secret/file");
    expect(tool).toBe("customer-secret/file");
    expect(ownSite(tool)).toBe("own-route:tool:unlisted");
    expect(ownSite("email_send")).toBe("own-route:email_send");
  });
  it("an own route names its fixed route and a plain rpc method; anything else is other / route:unlisted", () => {
    expect(ownSite("route:/api/internal/unified-browser", "tools/call")).toBe("own-route:route:/api/internal/unified-browser rpc=tools/call");
    expect(ownSite("route:/api/internal/host-computer", "resources/list")).toBe("own-route:route:/api/internal/host-computer rpc=resources/list");
    expect(ownSite("route:/api/internal/unified-browser", "tools/list-and-more")).toBe("own-route:route:/api/internal/unified-browser rpc=other");
    expect(ownSite("route:/api/internal/unified-browser", "")).toBe("own-route:route:/api/internal/unified-browser rpc=other");
    expect(ownSite("route:/api/internal/mcp-remote/secret-name")).toBe("own-route:route:/api/internal/mcp-remote");
    expect(ownSite("route:/api/internal/some/C:\\Users\\x\\key.pem")).toBe("own-route:route:unlisted");
    expect(ownSite("web_search")).toBe("own-route:web_search");
    expect(safeMarkSite("item:interpreter branch=i4+i13")).toBe("item:interpreter branch=i4+i13");
    expect(safeMarkSite("a path /Users/x/secret$(rm)")).toBe("other"); // secret-scan: fixture
    expect(safeMarkSite(undefined)).toBe("unlabelled");
  });
  it("the own-tool gate logs the unified-browser site with the rpc method", () => {
    wire();
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    beginOutsideTurn("t2", "i", undefined, false);
    const tool = ownToolOfRoute("POST", "/api/internal/unified-browser", { method: "tools/call" });
    expect(ownToolGate({ threadId: "t2", botId: "b", tool, lane: true, rpc: "tools/call" })).toBeNull();
    expect(turnOutsideRead("t2")).toBe("outside tool");
    expect(logged(spy)).toEqual(["outside: first-mark thread=t2 source=outside tool site=own-route:route:/api/internal/unified-browser rpc=tools/call"]);
  });
});

describe("NL-WIN-1018 D4: Windows pwsh, the owner's own clean No limits turn", () => {
  let dir = "";
  let outside = "";
  const text0 = "bash ./build.sh";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nlwin-d4-"));
    outside = mkdtempSync(join(tmpdir(), "nlwin-out-"));
    writeFileSync(join(dir, "build.sh"), "#!/bin/bash\necho NL-MARK > out.txt\n");
    writeFileSync(join(dir, "b.sh"), "#!/bin/bash\necho hi\n");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.sh"), "#!/bin/bash\necho hi\n");
    writeFileSync(join(outside, "x.sh"), "#!/bin/bash\necho x\n");
    symlinkSync(outside, join(dir, "junction"));
    mkdirSync(join(dir, ".ssh"));
    writeFileSync(join(dir, ".ssh", "run.sh"), "#!/bin/bash\n");
    writeFileSync(join(dir, "NUL.sh"), "#!/bin/bash\n");
  });
  const verdict = (bot: object, text: string, extra: object = {}) => autoVerdict(bot as never, "Bash", text, {
    handedShellPath: (() => {
      const dirs: Record<string, Record<string, string>> = { "c:\\program files\\git\\bin": { "bash.exe": "f", "sh.exe": "f" }, "c:\\windows\\system32": { "cmd.exe": "f" } };
      const at = (p: string) => { const i = p.lastIndexOf("\\"); return dirs[p.slice(0, i).toLowerCase()]?.[p.slice(i + 1).toLowerCase()]; };
      return {
        path: "C:\\Program Files\\Git\\bin;C:\\Windows\\System32", pathExt: ".COM;.EXE;.BAT;.CMD", gitBash: "C:\\Program Files\\Git\\bin\\bash.exe",
        list: (dir: string) => { const d = dirs[dir.toLowerCase()]; if (!d) throw new Error("EPERM"); return Object.keys(d); },
        lstat: (p: string) => { if (!at(p)) throw new Error("ENOENT"); return { isFile: () => true, isSymbolicLink: () => false }; },
        realpath: (p: string) => p,
      };
    })(),
    fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null, commandText: text, commandCwd: dir, workFolder: dir,
    call: { engine: "codex", commandShell: "pwsh", toolCall: { name: "shell", input: { command: text } } },
    ...extra,
  } as unknown as Context);
  it.each(["bash ./build.sh", "sh ./build.sh", "bash ./sub/b.sh", "bash sub/b.sh"])("runs %s", (text) => {
    expect(verdict(NO_LIMITS, text)).toMatchObject({ approve: "auto-approved Bash (no limits)", source: "no-limits" });
  });
  it.each([
    "bash ./build.sh; Remove-Item x", "bash ./build.sh && echo hi", "bash ./build.sh | Out-Null",
    "bash ./b.sh > o", "bash ./b.sh 2>&1",
    "bash -x ./b.sh", "bash --rcfile x ./b.sh",
    "bash $env:X", "bash $(Get-Item x)", "bash ./$name.sh", "bash ./b`$x.sh", "bash @args",
    "bash ../out.sh", "bash sub/../../x.sh",
    "bash C:\\tmp\\b.sh", "bash /c/tmp/b.sh", "bash \\\\srv\\s\\b.sh", "bash ./b.sh:ads",
    "bash .\\build.sh", "bash bash.exe", "bash.exe ./build.sh", "bash ./junction/x.sh",
    "bash build.sh",
    "bash -c './build.sh'", "bash ./b.sh; Remove-Item -Recurse C:\\", "cmd /c build.bat", "powershell -c ./build.sh",
    "bash ./.ssh/run.sh", "/bin/bash ./build.sh", "bash './build.sh'", "bash ./build.sh extra", "bash ./b.sh\nRemove-Item x",
  ])("holds below No limits, runs at No limits unless it names a wipe: %s", (text) => {
    // NOLIM 1.0.19 (Sean 2026-11-10): the owner's No limits turn runs what the reader cannot follow; only the wipe list (and the plainWipe
    // proxy, here the Remove-Item rows) stays a card. Full access still holds every spelling the D4 admission does not take.
    expectNoLimitsOwnerOutcome(verdict(NO_LIMITS, text), text, undefined, text);
    const held = verdict(FULL, text);
    expect(held.approve, `${text} at Full access`).toBeNull();
    expect(held.source, text).toBe("always-ask");
    expect(held.rule, text).toBe("unreadable");
  });
  it("a script on a deny-ruled path keeps the deny card (a link under the folder to a system folder)", () => {
    symlinkSync("/etc", join(dir, "etc-link"));
    symlinkSync("/usr/bin", join(dir, "usrbin-link"));
    for (const text of ["bash ./etc-link/x.sh", "bash etc-link/x.sh", "bash ./usrbin-link/x.sh"]) {
      // NOLIM 1.0.19: the owner's No limits turn runs a protected-path row (only the wipe list still cards); Full access still holds it
      expect(verdict(FULL, text).approve, text).toBeNull();
      expectNoLimitsOwnerOutcome(verdict(NO_LIMITS, text), text, "protected-path", text);
    }
  });
  it("the same bash ./build.sh cards at Auto and Ask; at Full access it runs as the Claude Bash tool's own text does (WIN-PWSH-1018)", () => {
    for (const bot of [AUTO, ASK]) expect(verdict(bot, text0).approve, JSON.stringify(bot)).toBeNull();
    expect(verdict(FULL, text0).approve).not.toBeNull();
  });
  // NOLIM 1.0.19 (N2.4): the finalizer reads the STORED origin only. Work that is not provably the owner's (another origin, no stored origin,
  // unattended, automated, channel-owner facts that conflict with an owner origin) keeps the card.
  it.each<[string, object]>([
    ["no proof", { ownerStarted: false, fullAccessOrigin: undefined }],
    ["origin other", { fullAccessOrigin: "other" }], ["unattended", { unattended: true }], ["automated", { automated: true }],
    ["channelOwner", { channelOwner: true }],
  ])("the same bash ./build.sh cards on a %s", (_name, extra) => {
    const found = verdict(NO_LIMITS, text0, extra);
    expect(found.approve).toBeNull();
  });
  // the marks and the cut or missing input are not read at No limits: the owner's work runs
  it.each<[string, object]>([
    ["marked turn", { outsideRead: ["web page"] }], ["outsideRead absent", { outsideRead: undefined }], ["routineLevel", { routineLevel: true }],
    ["scope set", { scope: "local-computer" }], ["inputCut", { inputCut: true }], ["inputTruncated", { inputTruncated: true }],
    ["inputMissing", { call: { engine: "codex", commandShell: "pwsh", inputMissing: "command", toolCall: { name: "shell", input: {} } } }], ["commandCwdInvalid", { commandCwdInvalid: true }],
  ])("the same bash ./build.sh runs at No limits on a %s", (_name, extra) => {
    expect(verdict(NO_LIMITS, text0, extra).approve).toBeTruthy();
  });
  it("on a Windows folder (drive cwd, stubbed disk): the same shape runs, a device name, a junction and an ADS card", () => {
    const winDir = "C:\\Users\\o\\bot";
    const links: Record<string, string> = { "c:/users/o/bot/junction/x.sh": "d:/elsewhere/x.sh" };
    const unseen = {
      platform: "win32" as const,
      realpath: (path: string) => { const flat = path.replace(/\\/g, "/"); return links[flat.toLowerCase()] ?? flat.replace("c:/Users", "C:/Users"); },
    };
    const fs = { realpath: unseen.realpath, stat: () => ({ isFile: () => true, isDirectory: () => false }), head: () => new TextEncoder().encode("#!/bin/sh\n") };
    const win = (text: string) => verdict(NO_LIMITS, text, { commandCwd: winDir, workFolder: winDir, unseen: { platform: "win32", fs } });
    expect(win("bash ./build.sh")).toMatchObject({ approve: "auto-approved Bash (no limits)", source: "no-limits" });
    expect(win("bash sub/b.sh")).toMatchObject({ source: "no-limits" });
    // NOLIM 1.0.19: the D4 admission still does not take these spellings (Full access holds them); the owner's No limits turn runs them
    for (const text of ["bash ./NUL.sh", "bash ./con.txt.sh", "bash ./junction/x.sh", "bash ./b.sh:ads", "bash .\\build.sh", "bash C:\\tmp\\b.sh", "bash ./sub./b.sh"]) {
      expectNoLimitsOwnerOutcome(win(text), text, undefined, text);
    }
  });
  it("Astra 1: the D4 admission needs the whole clean gate even when the lane seam is off", () => {
    const seamOff = { noPreRunSeamAtNoLimits: true };
    // NOLIM 1.0.19: the outside marks are not read at No limits, so the seam being off changes nothing there: the owner's work runs
    for (const extra of [{ outsideRead: ["web page"] }, { outsideRead: undefined }, { outsideRead: ["outside tool"] }]) {
      expect(verdict(NO_LIMITS, text0, { ...seamOff, ...extra }).approve, JSON.stringify(extra)).toBeTruthy();
    }
  });
  it("Astra 2: a script the session already knows still goes through the D4 checks and the owner waiver", () => {
    const known = (text: string, extra: object = {}) => verdict(NO_LIMITS, text, {
      sessionFile: () => ({ text: "echo hi\n" }), readOnlyHooks: { sessionEdits: new Set([join(dir, "build.sh"), join(dir, "junction", "x.sh")]) }, ...extra });
    // a clean session-known script has no unseen path, so D4 cannot place it: it keeps the PowerShell card (fail closed, never a bypass)
    // (NOLIM 1.0.19: the owner's No limits turn runs each of these)
    for (const [text, extra] of [[text0, {}], [text0, { inputCut: true }], [text0, { outsideRead: ["web page"] }], ["bash ./junction/x.sh", {}]] as const) {
      expect(known(text, extra).approve, text).toBeTruthy();
    }
  });
  it("a missing script, and no cwd, card below No limits and run at the owner's No limits turn (an unreadable text is not a wipe)", () => {
    expect(verdict(FULL, "bash ./nothere.sh").approve).toBeNull();
    expect(verdict(FULL, text0, { commandCwd: undefined, workFolder: undefined }).approve).toBeNull();
    expect(verdict(NO_LIMITS, "bash ./nothere.sh").approve).toBeTruthy();
    expect(verdict(NO_LIMITS, text0, { commandCwd: undefined, workFolder: undefined }).approve).toBeTruthy();
  });
  it("the fail-closed boundary keeps its exact wipe card on POSIX and pwsh", () => {
    const posix = (text: string) => verdict(NO_LIMITS, text, { call: undefined });
    expect(posix("rm -rf /")).toMatchObject({ approve: null, source: "always-ask", rule: "delete-root", classification: "deny" });
    expect(posix("rm -rf ~")).toMatchObject({ approve: null, source: "always-ask", rule: "delete-home", classification: "deny" });
    expect(posix(":(){ :|:& };:")).toMatchObject({ approve: null, source: "always-ask", rule: "fork-bomb", classification: "deny" });
    expect(posix("dd if=/dev/zero of=/dev/sda")).toMatchObject({ approve: null, source: "always-ask", rule: "disk-erase", classification: "deny" });
    expect(posix("mkfs.ext4 /dev/sda1")).toMatchObject({ approve: null, source: "always-ask", rule: "disk-erase", classification: "deny" });
    expect(verdict(NO_LIMITS, "Remove-Item -Recurse -Force C:\\")).toMatchObject({ approve: null, source: "always-ask", rule: "delete-root", classification: "deny" });
    expect(verdict(NO_LIMITS, "Format-Volume -DriveLetter C")).toMatchObject({ approve: null, source: "always-ask", rule: "disk-erase", classification: "deny" });
    expect(verdict(NO_LIMITS, "Clear-Disk -Number 0 -RemoveData")).toMatchObject({ approve: null, source: "always-ask", rule: "disk-erase", classification: "deny" });
    expect(verdict(NO_LIMITS, "bash ./b.sh; rm -rf /").approve).toBeNull();
  });
});

describe("NL-WIN-1018 D5: a shell's -o <set-option name> is not an output file (gc-13)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "nlwin-d5-"));
  const target = join(scratch, "elsewhere");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "x"), "x\n");
  const owner = (text: string) => autoVerdict(NO_LIMITS as never, "Bash", text, { fullAccessOrigin: "owner" } as unknown as Context);
  it("runs bash -o errexit -c 'rm -f <dir>/x' at the corpus owner context, as bash -c does", () => {
    expect(owner(`bash -c 'rm -f ${target}/x'`)).toMatchObject({ source: "no-limits" });
    expect(owner(`bash -o errexit -c 'rm -f ${target}/x'`)).toMatchObject({ source: "no-limits" });
    expect(owner(`bash -o pipefail -o errexit -c 'rm -f ${target}/x'`)).toMatchObject({ source: "no-limits" });
  });
  it("keeps today's reading for a name outside the list, a pair the -c reader does not accept, and fish", () => {
    for (const text of [`bash -o foo -c 'rm -f ${target}/x'`, `bash -oc errexit 'ls'`, `bash -xo errexit -c 'ls'`, `fish -o errexit -c 'ls'`]) {
      // NOLIM 1.0.19: the reader's reading is unchanged (these are not the corpus rows that run via the -o fix); the owner's No limits turn
      // runs them unless the text names a wipe (the `rm -f` row does, through the plainWipe proxy)
      expectNoLimitsOwnerOutcome(owner(text), text, undefined, text);
    }
  });
});

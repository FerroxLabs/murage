// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.8 Windows gate: every ordinary command asked at Full access with U20 "the shell environment check could not be read".
// The shells answered correctly; the hand did not. The Windows owner capture spreads process.env (which spells it "Path")
// and adds "PATH", so the handed map held both spellings with different values, and the fold of the HANDED side called that a
// case alias. Node's win32 spawn hands the child one spelling (the first in sorted order), so the hand is now folded the
// same way. The fixtures are the real envelopes captured on the gate box (PowerShell 5.1 -NoProfile -Command, Git for
// Windows bash -c), cwd C:\tmp\g108-work, with only the SSH addresses replaced by documentation addresses.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ABSENT_PINS, type PinRun } from "../shared/arg-vocabulary.ts";
import { compareCheck, comparePowerShellCheck, envAsSpawned, handEnv, type HandedEnv } from "./engine-env.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./testing/fixtures/win-envcheck-108/${name}`, import.meta.url));
const handedMap: Record<string, string> = JSON.parse(readFileSync(fixture("handed.json"), "utf8"));
// execCli decodes stdout as UTF-8, exactly so
const psOut = readFileSync(fixture("powershell-51.stdout.json")).toString("utf8");
const bashOut = readFileSync(fixture("git-bash.stdout.bin")).toString("utf8");
const NONCE = "0123456789abcdef0123456789abcdef";
const CWD = "C:\\tmp\\g108-work";
const noRun: PinRun = async () => ({ ok: false, stdout: "", stderr: "" });
const hand = (env: Record<string, string>): HandedEnv => ({ env, absent: [...ABSENT_PINS], capture: "session", ownerStartup: {}, pins: new Map() });
const spellings = (env: Record<string, string>, name: string) => Object.keys(env).filter((key) => key.toUpperCase() === name);

describe("1.0.8 Windows environment check reads the real envelopes", () => {
  it("the fixtures are what the gate box saw: a hand with Path and PATH, one PATH in each shell's print", () => {
    expect(spellings(handedMap, "PATH").sort()).toEqual(["PATH", "Path"]);
    expect(handedMap.PATH).not.toBe(handedMap.Path);
    const printed = JSON.parse(psOut) as { env: [string, string][] };
    expect(printed.env.filter(([name]) => name.toUpperCase() === "PATH")).toEqual([["PATH", handedMap.PATH]]);
    expect(bashOut.endsWith("\0\0/c/tmp/g108-work\n")).toBe(true);
  });

  it("PowerShell 5.1 envelope: reads (was case-alias, U20) and the record keeps the PATH the child received", () => {
    const result = comparePowerShellCheck(hand(handedMap), CWD, psOut, NONCE, "win32");
    expect(result).toMatchObject({ ok: true, cwdKnown: true });
    if (!result.ok) return;
    expect(result.env.PATH).toBe(handedMap.PATH);
    expect(result.env.Path).toBeUndefined();
    expect(result.unknown.filter((name) => name.toUpperCase() === "PATH")).toEqual([]);
  });

  it("Git Bash envelope (env -0, NUL, MSYS pwd): reads on win32 with Path and PATH both in the hand", () => {
    const result = compareCheck(hand(handedMap), CWD, bashOut, "win32");
    expect(result).toMatchObject({ ok: true, cwdKnown: true });
  });

  it("a case alias in what the SHELL printed is still held", () => {
    const printed = JSON.parse(psOut) as { env: [string, string][] };
    printed.env.push(["path", "C:\\elsewhere"]);
    expect(comparePowerShellCheck(hand(handedMap), CWD, JSON.stringify(printed), NONCE, "win32")).toMatchObject({ ok: false, reason: "case-alias" });
    const doubled = bashOut.replace("\0\0/c/tmp", "\0Path=/c/elsewhere\0\0/c/tmp");
    expect(compareCheck(hand(handedMap), CWD, doubled, "win32")).toMatchObject({ ok: false, reason: "case-alias" });
  });

  it("off win32 nothing is folded: the same hand is still a case alias there", () => {
    expect(comparePowerShellCheck(hand(handedMap), CWD, psOut, NONCE, "linux")).toMatchObject({ ok: false, reason: "case-alias" });
    expect(envAsSpawned({ Path: "a", PATH: "b" }, "darwin")).toEqual({ Path: "a", PATH: "b" });
  });

  it("a malformed print with a doubled hand: case-alias off win32, as before 1.0.8; invalid-envelope on win32", () => {
    const printed = JSON.parse(psOut) as { env: unknown[] };
    printed.env.push(["X", 3]);
    const malformed = JSON.stringify(printed);
    expect(comparePowerShellCheck(hand(handedMap), CWD, malformed, NONCE, "linux")).toMatchObject({ ok: false, reason: "case-alias" });
    expect(comparePowerShellCheck(hand(handedMap), CWD, malformed, NONCE, "darwin")).toMatchObject({ ok: false, reason: "case-alias" });
    // win32 folds the hand to the one spelling the child received, so only the print is wrong
    expect(comparePowerShellCheck(hand(handedMap), CWD, malformed, NONCE, "win32")).toMatchObject({ ok: false, reason: "invalid-envelope" });
    // a single-spelling hand with the same print is invalid-envelope everywhere
    const single = { ...handedMap }; delete single.Path;
    for (const platform of ["linux", "win32"] as const) expect(comparePowerShellCheck(hand(single), CWD, malformed, NONCE, platform)).toMatchObject({ ok: false, reason: "invalid-envelope" });
  });
});

describe("1.0.8 the Windows hand is the map the child receives", () => {
  it("envAsSpawned keeps the first spelling in sorted order, as Node's win32 spawn does", () => {
    expect(envAsSpawned({ Path: "registry", PATH: "augmented", windir: "C:\\Windows" }, "win32")).toEqual({ PATH: "augmented", windir: "C:\\Windows" });
  });

  it("envAsSpawned keeps a variable named __proto__ on win32 (a null-prototype map) and leaves the map as is elsewhere", () => {
    const env = JSON.parse('{"__proto__":"kept","Path":"registry","PATH":"augmented"}') as Record<string, string>;
    expect(Object.hasOwn(env, "__proto__")).toBe(true);
    const spawned = envAsSpawned(env, "win32");
    expect(Object.getPrototypeOf(spawned)).toBe(null);
    expect(Object.hasOwn(spawned, "__proto__")).toBe(true);
    expect(spawned["__proto__"]).toBe("kept");
    expect(Object.keys(spawned).sort()).toEqual(["PATH", "__proto__"]);
    const posix = envAsSpawned(env, "linux");
    expect(Object.getPrototypeOf(posix)).toBe(Object.prototype);
    expect(Object.keys(posix)).toEqual(["__proto__", "Path", "PATH"]);
    expect(Object.hasOwn(posix, "__proto__")).toBe(true);
  });

  it("handEnv on win32 hands a variable named __proto__ through", async () => {
    const owner = JSON.parse('{"__proto__":"kept"}') as Record<string, string>;
    Object.assign(owner, handedMap);
    const handed = await handEnv({ env: owner, capture: "session" }, { platform: "win32", run: noRun, cwd: CWD });
    expect(Object.hasOwn(handed.env, "__proto__")).toBe(true);
    expect(handed.env["__proto__"]).toBe("kept");
  });

  it("handEnv on win32 hands one PATH spelling, and pins replace a name in any spelling", async () => {
    const owner = { ...handedMap, git_terminal_prompt: "1" };
    const handed = await handEnv({ env: owner, capture: "session" }, { platform: "win32", run: noRun, cwd: CWD });
    expect(spellings(handed.env, "PATH")).toEqual(["PATH"]);
    expect(handed.env.PATH!.startsWith(handedMap.PATH!)).toBe(true);
    expect(spellings(handed.env, "GIT_TERMINAL_PROMPT").map((key) => handed.env[key])).toEqual(["0"]);
    // every spelling the hand holds is unique ignoring case, so the probe and the record see the same map
    const upper = Object.keys(handed.env).map((key) => key.toUpperCase());
    expect(new Set(upper).size).toBe(upper.length);
  });

  it("handEnv on win32 removes an absence pin in every spelling", async () => {
    const owner: Record<string, string> = { ...handedMap };
    for (const name of ABSENT_PINS) { owner[name.toLowerCase()] = "x"; owner[name[0] + name.slice(1).toLowerCase()] = "y"; }
    const handed = await handEnv({ env: owner, capture: "session" }, { platform: "win32", run: noRun, cwd: CWD });
    for (const name of ABSENT_PINS) expect(spellings(handed.env, name.toUpperCase())).toEqual([]);
  });

  it("handEnv off win32 keeps both spellings, as before", async () => {
    const handed = await handEnv({ env: { Path: "a", PATH: "/usr/bin", HOME: "/home/o" }, capture: "session" }, { platform: "linux", run: noRun, cwd: "/home/o" });
    expect(handed.env.Path).toBe("a");
    expect(handed.env.PATH!.startsWith("/usr/bin")).toBe(true);
  });

  it("a hand built on win32 from the box's owner map passes the real PowerShell check", async () => {
    const handed = await handEnv({ env: handedMap, capture: "session" }, { platform: "win32", run: noRun, cwd: CWD });
    const printed = JSON.parse(psOut) as { env: [string, string][] };
    // the probe child receives exactly the hand: answer with it
    printed.env = Object.entries(handed.env);
    expect(comparePowerShellCheck(handed, CWD, JSON.stringify(printed), NONCE, "win32")).toMatchObject({ ok: true, cwdKnown: true });
  });
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-PWSH-1018 H1 (M1): the Git Bash a Windows F12 record carries is found by the Claude driver's discovery (tool-discovery.ts), and
// a generation that moves while it is being found makes the record stale (execEnvNow runs again, never returns the old record).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixturePlatformEnv } from "./testing/platform-fixtures.ts";
import { describe, expect, it } from "vitest";
import { attachGitBash, execEnvNow } from "./engine-env.ts";
import { envGeneration, invalidateEnvCapture } from "./env-path.ts";
import { isExecEnv, envInfoOf, type ExecEnv } from "../shared/mount-identity.ts";

const record = (extra: Partial<ExecEnv> = {}): ExecEnv => ({ env: { PATH: "C:\\Program Files\\Git\\bin", PATHEXT: ".EXE" }, absent: [], cwd: "C:\\w", shell: ["powershell.exe", "-NoProfile", "-Command"], capture: "session", ...extra });

describe("WIN-PWSH-1018 H1: the F12 record's Git Bash", () => {
  it("adds the discovered Git Bash on win32, from the env the record carries", async () => {
    let seen: Readonly<Record<string, string>> | undefined;
    const at = envGeneration();
    const done = await attachGitBash(record(), at, "win32", async (env) => { seen = env; return "C:\\Program Files\\Git\\bin\\bash.exe"; });
    expect(done).toMatchObject({ gitBash: "C:\\Program Files\\Git\\bin\\bash.exe" });
    expect(seen).toEqual(record().env);
    expect(isExecEnv(done)).toBe(true);
    expect(JSON.stringify(envInfoOf(done as ExecEnv))).not.toContain("bash.exe");
  });
  it("leaves it out when discovery finds none or throws, off win32, and for an unread or unchecked record (the gate holds)", async () => {
    const at = envGeneration();
    expect(await attachGitBash(record(), at, "win32", async () => null)).not.toHaveProperty("gitBash");
    expect(await attachGitBash(record(), at, "win32", async () => { throw new Error("x"); })).not.toHaveProperty("gitBash");
    expect(await attachGitBash(record(), at, "linux", async () => "/bin/bash")).not.toHaveProperty("gitBash");
    expect(await attachGitBash(record({ unread: { code: "U20", cause: "x" } }), at, "win32", async () => "C:\\g\\bash.exe")).not.toHaveProperty("gitBash");
    expect(await attachGitBash(record({ unchecked: { reason: "timeout" } }), at, "win32", async () => "C:\\g\\bash.exe")).not.toHaveProperty("gitBash");
  });
  it("a generation that moves during discovery makes the record stale, never returned", async () => {
    const at = envGeneration();
    const done = await attachGitBash(record(), at, "win32", async () => { invalidateEnvCapture("test: startup file approved during discovery"); return "C:\\Program Files\\Git\\bin\\bash.exe"; });
    expect(done).toBe("changed");
    expect(envGeneration()).toBe(at + 1);
  });
  it("a malformed gitBash is not trusted", () => {
    expect(isExecEnv({ ...record(), gitBash: 3 })).toBe(false);
  });
  // Check the actual host shell, while keeping Git Bash discovery injected.
  const windows = process.platform === "win32";
  const cwd = windows ? tmpdir() : "/tmp";
  const shell: readonly string[] = windows
    ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command"]
    : ["/bin/sh", "-c"];
  const hand = { env: windows ? { ...fixturePlatformEnv(), PATH: process.env.PATH ?? "", HOME: cwd, USERPROFILE: cwd, PAGER: "cat" } as Record<string, string> : { PATH: "/usr/bin:/bin", HOME: "/tmp", PAGER: "cat" }, absent: ["POSIXLY_CORRECT"], capture: "session" as const, ownerStartup: {}, pins: new Map() };
  it("execEnvNow runs again when the generation moves during discovery, and keeps the later record", async () => {
    let calls = 0;
    const found = await execEnvNow("m1-retry", shell, hand, cwd, { platform: "win32", discover: async () => { if (++calls === 1) invalidateEnvCapture("test: during discovery"); return "C:\\Program Files\\Git\\bin\\bash.exe"; } });
    expect(calls).toBe(2);
    expect(found).toMatchObject({ gitBash: "C:\\Program Files\\Git\\bin\\bash.exe" });
    expect(found.unread).toBeUndefined();
  });
  it("a generation that keeps moving during discovery ends as U20 changed-while-checked, never an old record", async () => {
    let calls = 0;
    const found = await execEnvNow("m1-exhaust", shell, hand, cwd, { platform: "win32", discover: async () => { calls++; invalidateEnvCapture("test: during every discovery"); return "C:\\g\\bin\\bash.exe"; } });
    expect(calls).toBe(4); // the first attempt and the three bounded reruns
    expect(found.env).toEqual({});
    expect(found.unread).toEqual({ code: "U20", cause: "the environment changed while it was being checked" });
    expect(found).not.toHaveProperty("gitBash");
  });
  it("discovery that finds nothing, or rejects, still returns the checked record without gitBash", async () => {
    for (const discover of [async () => null, async () => { throw new Error("x"); }]) {
      const found = await execEnvNow("m1-none", shell, hand, cwd, { platform: "win32", discover });
      expect(found.unread).toBeUndefined();
      expect(found).not.toHaveProperty("gitBash");
    }
  });
});

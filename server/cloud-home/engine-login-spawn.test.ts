// SPDX-License-Identifier: AGPL-3.0-or-later
// AGY-ON-CLOUD 13 r2 test (i): every B-mode login the relay spawns carries `commit: true` and the FD 4 channel; nothing else does.
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ request: Record<string, unknown>; options: unknown }> = [];
vi.mock("./bot-state.ts", () => ({ spawnCloudLauncher: (request: Record<string, unknown>, options?: unknown) => { calls.push({ request, options }); return {} as never; } }));
beforeEach(() => { calls.length = 0; });

describe("the relay's launcher request", () => {
  it("(i) every per-bot login carries commit and the channel; logout, key enrollment and Claude's login do not", async () => {
    const { spawnEngineLoginLauncher } = await import("./engine-login.ts");
    for (const engine of ["codex", "antigravityAgent", "grokAgent", "kimiAgent", "opencodeGo"] as const) spawnEngineLoginLauncher(engine, "login", { bot: "atlas" });
    expect(calls.map(c => c.request.commit)).toEqual([true, true, true, true, true]);
    expect(calls.every(c => JSON.stringify(c.options) === JSON.stringify({ commitChannel: true }))).toBe(true);
    expect(calls[1]!.request).toMatchObject({ mode: "login", engine: "antigravity", action: "login", pty: true, bot: "atlas", commit: true });
    calls.length = 0;
    spawnEngineLoginLauncher("antigravityAgent", "logout", { bot: "atlas" });
    spawnEngineLoginLauncher("codex", "enroll-key", { secret: "fixture-codex-key-0123456789" }); // secret-scan: fixture
    spawnEngineLoginLauncher("claudeAgent", "login", {});
    expect(calls.map(c => c.request.commit)).toEqual([undefined, undefined, undefined]);
    expect(calls.map(c => JSON.stringify(c.options))).toEqual(["{}", "{}", "{}"]);
  });
});

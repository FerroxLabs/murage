// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LINUX-NOKEYRING-ENV-KEY: the Flux status says why no key can be saved on a desktop with no unlocked keyring.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripWorkspaceCredentialEnv } from "./config.ts";
import { fluxSaveBlocked } from "./flux-connection-apply.ts";

describe("Flux status on a desktop with no unlocked keyring", () => {
  const desktop = { MURAGE_DESKTOP_PARENT: "1", MURAGE_SECRET_SAVE_REFUSED: "keyring" };
  it("carries the reason only when the desktop shell's own child was told it", () => {
    expect(fluxSaveBlocked(desktop, false, true)).toEqual({ saveBlocked: "keyring" });
  });
  it("carries nothing for a server-only start, a Cloud home, or any other value", () => {
    expect(fluxSaveBlocked({ MURAGE_SECRET_SAVE_REFUSED: "keyring" }, false, false), "server-only start").toEqual({});
    expect(fluxSaveBlocked(desktop, false, false), "server-only start with both strings exported but no desktop parent").toEqual({});
    expect(fluxSaveBlocked(desktop, true, true), "Cloud home").toEqual({});
    for (const value of [undefined, "", "storage", "KEYRING", "sk-flux-FAKE"]) expect(fluxSaveBlocked({ ...desktop, MURAGE_SECRET_SAVE_REFUSED: value }, false, true)).toEqual({});
  });
  it("is spread into the one status wrapper the Flux routes answer with (source check)", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const fluxSaveBlockedAtBoot = fluxSaveBlocked\(process\.env, Boolean\(cloudHome\), Boolean\(utilityParentPort\)\);/);
    // every Flux status route answers through the wrapper
    const routes = source.split("\n").filter(line => /\/api\/flux-connection/.test(line) && /json\(res, 200,/.test(line));
    expect(routes.length).toBeGreaterThan(0);
    for (const line of routes) expect(line).toMatch(/fluxConnectionStatusWithRestart\(/);
    expect(source).toMatch(/const fluxConnectionStatusWithRestart = [^\n]*\.\.\.fluxSaveBlockedAtBoot \}\);/);
  });
  it("the workspace credential strip drops the offered shell key (helper check; engine builders call this strip)", () => {
    const engine: Record<string, string | undefined> = { PATH: "/bin", MURAGE_FLUX_AMBIENT_KEY: "sk-flux-FAKE_SHELL", MURAGE_SECRET_SAVE_REFUSED: "keyring" };
    stripWorkspaceCredentialEnv(engine, "linux");
    expect(engine.MURAGE_FLUX_AMBIENT_KEY).toBeUndefined();
    expect(JSON.stringify(engine)).not.toContain("sk-flux");
    const windows: Record<string, string | undefined> = { Murage_Flux_Ambient_Key: "sk-flux-FAKE_SHELL" };
    stripWorkspaceCredentialEnv(windows, "win32");
    expect(JSON.stringify(windows)).not.toContain("sk-flux");
  });
});

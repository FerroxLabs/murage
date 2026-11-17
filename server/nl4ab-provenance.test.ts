// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginOutsideTurn, markTurnOutside } from "./email/external-marks.ts";
import * as localFs from "./outside-dl.ts";
import * as register from "./outside-register.ts";
import { acpOutsideHooks, noteToolStartOutside, outsideAuthorityForExecution, type ToolStart } from "./outside-wire.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";

useOutsideStoreFixture();
afterEach(() => vi.restoreAllMocks());

describe("nl4ab authority isolation through existing tool-start boundary", () => {
  it.each(["cloud-launcher", "box", "remote", "unknown"])("A-REMOTE-ISOLATION: %s never enters local filesystem registration", kind => {
    beginOutsideTurn("remote-thread", "keys", "generation-1", false);
    markTurnOutside("remote-thread", "web page");
    const fs = vi.spyOn(localFs, "nodeFsHooks");
    const registration = vi.spyOn(register, "registerText");
    // Baseline accepts ToolStart and ignores this additional authenticated
    // adapter context. No missing import or synthetic verdict is the RED.
    const item: ToolStart & { provenance: unknown } = {
      origin: "engine", title: "Bash", input: { command: "npm install", cwd: "/work" },
      provenance: { botId: "bot-b", threadId: "remote-thread", generation: "generation-1", occurrence: "call-1",
        authority: { kind, id: "shared-home-epoch", namespaceId: "namespace-b" },
        cwd: { state: "valid", original: "/work" }, dialect: "posix", enginePath: { state: "unknown" } },
    };
    noteToolStartOutside("remote-thread", item, "/work");
    expect(fs, "remote paths must never construct server-local FsHooks").not.toHaveBeenCalled();
    expect(registration, "remote paths must never use the local registry").not.toHaveBeenCalled();
  });
  it.each(["relative", "bad\0cwd", 7, null, { cwd: "/one", workdir: "/two" }])("A-CWD-INVALID: %j never registers at turn cwd", cwd => {
    beginOutsideTurn("cwd-thread", "keys", "generation-1", false);
    const registration = vi.spyOn(register, "registerText");
    const input = typeof cwd === "object" && cwd !== null ? { command: "npm install", ...cwd } : { command: "npm install", cwd };
    noteToolStartOutside("cwd-thread", { origin: "engine", title: "Bash", input }, "/valid-turn-folder");
    expect(registration.mock.calls.some(([, context]) => context.cwd === "/valid-turn-folder"), "invalid call cwd cannot borrow the turn's location").toBe(false);
  });
});


describe("authenticated adapter filesystem authority", () => {
  it.each(["claudeAgent", "codex", "piAgent", "fuigoAgent", "grokAgent", "geminiAgent", "cursorAgent", "kimiAgent", "droidAgent", "clineAgent", "opencodeGo", "antigravityAgent"])("%s is local only on the desktop server", driver => {
    expect(outsideAuthorityForExecution("thread", driver).kind).toBe("local");
    expect(outsideAuthorityForExecution("thread", driver, "home").kind).toBe("cloud-launcher");
  });
  it.each([undefined, "customAcp", "future-driver"])("unknown execution contract %s cannot select local FsHooks", driver => {
    const authority = outsideAuthorityForExecution("thread", driver);
    expect(authority.kind).toBe("unknown"); expect(Object.isFrozen(authority)).toBe(true);
  });
  it.each(["home", "unknown-role"])("ACP start, ask, merged update and helper marks do not inspect server disk on %s", role => {
    beginOutsideTurn("adapter-thread", "keys", "adapter-generation", false);
    const local = vi.spyOn(localFs, "nodeFsHooks"), registration = vi.spyOn(register, "registerText");
    const hooks = acpOutsideHooks(() => "/work", thread => outsideAuthorityForExecution(thread, "fuigoAgent", role));
    const call: ToolStart = { origin: "engine", title: "Bash", input: { command: "npm install", cwd: "/work" }, toolKind: "execute",
      provenance: { authority: { kind: "local" } } };
    hooks.judge("adapter-thread", call, false);
    hooks.judge("adapter-thread", call, true);
    hooks.judge("adapter-thread", { ...call, input: { command: "npm install other", cwd: "/work" } }, true);
    hooks.mark("adapter-thread", "helper");
    expect(local).not.toHaveBeenCalled(); expect(registration).not.toHaveBeenCalled();
  });
  it("a custom remote ACP wrapper cannot acquire local access from a tool hint", () => {
    beginOutsideTurn("custom-thread", "keys", "custom-generation", false);
    const local = vi.spyOn(localFs, "nodeFsHooks");
    noteToolStartOutside("custom-thread", { origin: "engine", title: "Bash", input: { command: "npm install", cwd: "/work" }, provenance: { authority: { kind: "local" } } }, "/work", {
      authority: outsideAuthorityForExecution("custom-thread", "customAcp"),
    });
    expect(local).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { engineConfigInvalid, engineFolderUnavailable, engineUpdateRequired, ScopeUnavailableError } from "./drivers/scoped-cli-home.ts";
import { LocalSetupError, localSetupEngineOf, localSetupFailureOf } from "./local-setup-failure.ts";
import { ProjectFolderLeaseError } from "./project-folder-leases.ts";

describe("local setup failure source", () => {
  it("reads the source from a tagged setup error", () => {
    expect(localSetupFailureOf(new LocalSetupError("computer", "the Local VM is not ready"))).toBe("computer");
    expect(localSetupFailureOf(new LocalSetupError("browser", "agent-browser command timed out"))).toBe("browser");
  });

  it("treats a working-folder lease refusal as the working folder", () => {
    expect(localSetupFailureOf(new ProjectFolderLeaseError("conflict"))).toBe("working-folder");
  });

  it("claims nothing for an untagged failure, whatever its text says", () => {
    expect(localSetupFailureOf(new Error("CUA Driver is not ready for this computer"))).toBeUndefined();
    expect(localSetupFailureOf(Object.assign(new Error("x"), { localFailure: "computer" }))).toBeUndefined();
    expect(localSetupFailureOf("agent-browser command timed out")).toBeUndefined();
  });

  it("reads an engine folder failure from its structured code and engine, never from its English text", () => {
    expect(localSetupFailureOf(new ScopeUnavailableError("tidied up", true))).toBe("engine-folder-busy");
    expect(localSetupFailureOf(engineFolderUnavailable("Antigravity", new Error("EACCES")))).toBe("engine-folder-unavailable");
    expect(localSetupFailureOf(engineUpdateRequired("Codex", "0.100.0", [0, 2, 0]))).toBe("engine-update-required");
    expect(localSetupEngineOf(engineUpdateRequired("Codex", undefined, [0, 2, 0]))).toBe("Codex");
    expect(localSetupFailureOf(new ScopeUnavailableError("x", false, { code: "symlink-required", engine: "Grok" }))).toBe("engine-symlink-required");
    expect(localSetupFailureOf(new ScopeUnavailableError("x", false, { code: "login-link-lost", engine: "Codex" }))).toBe("engine-login-link-lost");
    expect(localSetupFailureOf(engineConfigInvalid("OpenCode"))).toBe("engine-config-invalid");
    expect(localSetupEngineOf(engineConfigInvalid("OpenCode"))).toBe("OpenCode");
    expect(localSetupFailureOf(new Error("This bot's engine could not be set up in its own folder"))).toBeUndefined();
    expect(localSetupEngineOf(new Error("x"))).toBeUndefined();
  });
});

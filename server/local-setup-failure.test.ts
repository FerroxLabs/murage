import { describe, expect, it } from "vitest";
import { LocalSetupError, localSetupFailureOf } from "./local-setup-failure.ts";
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
});

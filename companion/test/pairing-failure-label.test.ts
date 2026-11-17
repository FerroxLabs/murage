// U1-SECURITY-FOLLOWUPS L1: the pairing failure log line carries only a plain
// identifier for the error's name and an allowlisted code, never what a
// thrower put in either.
import { describe, expect, it } from "vitest";
import { pairingFailureLabel } from "../src/proxy.ts";

describe("pairing failure log label", () => {
  it("keeps a plain error name and code", () => {
    expect(pairingFailureLabel(Object.assign(new TypeError("x"), { code: "ERR_INVALID" }))).toBe("TypeError ERR_INVALID");
    expect(pairingFailureLabel(new RangeError("x"))).toBe("RangeError");
  });

  it("replaces a name that is not a plain identifier with Error", () => {
    // MAIN RULING INT-CONFLICT-DEFAULT 76e4f565de 26d4947565: keep newer reviewed neutral fixture and redaction assertions.
    const secret = `pair-code 000000 token=${"a".repeat(16)}`;
    const named = Object.assign(new Error("x"), { name: secret });
    expect(pairingFailureLabel(named)).toBe("Error");
    expect(pairingFailureLabel(Object.assign(new Error("x"), { name: secret, code: "EPIPE" }))).toBe("Error EPIPE");
    expect(pairingFailureLabel(Object.assign(new Error("x"), { name: "A".repeat(60) }))).toBe("Error");
    expect(pairingFailureLabel(Object.assign(new Error("x"), { name: "" }))).toBe("Error");
    // identifier-shaped secrets: only the fixed list of names passes (U1 L1 r1)
    expect(pairingFailureLabel(Object.assign(new Error("x"), { name: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" }))).toBe("Error");
    expect(pairingFailureLabel(Object.assign(new Error("x"), { name: "CustomPairingError" }))).toBe("Error");
    expect(pairingFailureLabel(Object.assign(new DOMException("x", "AbortError")))).toBe("AbortError");
  });

  it("drops a code that is not allowlisted", () => {
    expect(pairingFailureLabel(Object.assign(new Error("x"), { code: "secret value" }))).toBe("Error");
    expect(pairingFailureLabel(Object.assign(new Error("x"), { code: "AKIA" + "IOSFODNN7EXAMPLE" }))).toBe("Error");
    expect(pairingFailureLabel(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("Error ECONNRESET");
  });
});

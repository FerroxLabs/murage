import { describe, expect, it } from "vitest";
import { assertFuigoCapturePin, assertTypedCapTurn, type ReleasePin } from "../../testing/fuigo-capture-proof.ts";

// Synthetic validator inputs, never binary provenance or captured root-cause evidence.
const source = "1234567890abcdef1234567890abcdef12345678";
const release: ReleasePin = { version: "1.0.42", source, packages: [
  { target: "linux-x64", name: "@fuigo/linux-x64", binarySha256: "a".repeat(64) },
] };
const capture = { binary: { version: `fuigo 1.0.42 (${source.slice(0, 12)})`, sha256: "a".repeat(64) } };
describe("R3 proof guards (synthetic validator inputs)", () => {
  it("accepts a capture matching the independent release pin", () => {
    expect(() => assertFuigoCapturePin(capture, release)).not.toThrow();
  });
  it("rejects an arbitrary well-formed binary digest", () => {
    expect(() => assertFuigoCapturePin({ binary: { ...capture.binary, sha256: "b".repeat(64) } }, release)).toThrow();
  });
  it("rejects a different source commit with the right version label", () => {
    expect(() => assertFuigoCapturePin({ binary: { ...capture.binary, version: "fuigo 1.0.42 (abcdef012345)" } }, release)).toThrow();
  });
  it("rejects an older release receipt", () => {
    expect(() => assertFuigoCapturePin(capture, { ...release, version: "1.0.41" })).toThrow();
  });
  it("rejects a pin for another platform", () => {
    expect(() => assertFuigoCapturePin(capture, { ...release, packages: [{ ...release.packages[0], target: "darwin-arm64", name: "@fuigo/darwin-arm64" }] })).toThrow();
  });
  it("rejects ambiguous Linux package receipts", () => {
    expect(() => assertFuigoCapturePin(capture, { ...release, packages: [...release.packages, ...release.packages] })).toThrow();
  });
  it("rejects legacy words as proof that typed state drove the turn", () => {
    expect(() => assertTypedCapTurn({ driverKind: "fuigoAgent", viaGateway: false, httpStatus: 429, errorText: "monthly free-tier token allowance" })).toThrow();
  });
  it("accepts the typed turn independently of the legacy words", () => {
    expect(() => assertTypedCapTurn({ driverKind: "fuigoAgent", viaGateway: false, httpStatus: 429, gatewayCode: "free_cap_reached", errorText: "Rate limited" })).not.toThrow();
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertFuigoCapturePin, assertPublishedFuigoCapture, assertTypedCapTurn, type PublishedCapturePin, type ReleasePin } from "../../testing/fuigo-capture-proof.ts";

// Synthetic validator inputs, never binary provenance or captured root-cause evidence.
const source = "1234567890abcdef1234567890abcdef12345678";
const release: ReleasePin = { version: "1.0.43", source, packages: [
  { target: "linux-x64", name: "@fuigo/linux-x64", binarySha256: "a".repeat(64) },
] };
const capture = { binary: { version: `fuigo 1.0.43 (${source.slice(0, 12)})`, sha256: "a".repeat(64) } };
describe("R3 proof guards (synthetic validator inputs)", () => {
  it("accepts a capture matching the independent release pin", () => {
    expect(() => assertFuigoCapturePin(capture, release)).not.toThrow();
  });
  it("rejects an arbitrary well-formed binary digest", () => {
    expect(() => assertFuigoCapturePin({ binary: { ...capture.binary, sha256: "b".repeat(64) } }, release)).toThrow();
  });
  it("rejects a different source commit with the right version label", () => {
    expect(() => assertFuigoCapturePin({ binary: { ...capture.binary, version: "fuigo 1.0.43 (abcdef012345)" } }, release)).toThrow();
  });
  it("rejects an older release receipt", () => {
    expect(() => assertFuigoCapturePin(capture, { ...release, version: "1.0.41" })).toThrow();
  });
  it("rejects a 1.0.42 receipt that cannot supply typed upstream state", () => {
    expect(() => assertFuigoCapturePin(capture, { ...release, version: "1.0.42" })).toThrow("independent 1.0.43 release receipt");
  });
  it("rejects an older capture even with the pinned digest and source", () => {
    expect(() => assertFuigoCapturePin({ binary: { ...capture.binary, version: `fuigo 1.0.42 (${source.slice(0, 12)})` } }, release)).toThrow();
  });
  it("rejects an unfilled release binary pin", () => {
    expect(() => assertFuigoCapturePin(capture, { ...release, packages: [{ ...release.packages[0], binarySha256: "FILL-AT-NPM" }] })).toThrow("release binary digest missing");
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

// Deliberately non-frame bytes: these exercise validation, never R3 replay.
const validatorBytes = Buffer.from("synthetic validator input only");
const publishedFile = "frames-S1-1.jsonl";
const publishedRelease: ReleasePin = { ...release, source: "Published release description", packages: [
  { ...release.packages[0], gitHead: source },
] };
const publishedPin: PublishedCapturePin = {
  version: "1.0.43", source_commit: source,
  binary: { version_output: capture.binary.version, sha256: capture.binary.sha256 },
  files_sha256: { [publishedFile]: createHash("sha256").update(validatorBytes).digest("hex") },
};
describe("published drop schema guards (synthetic validator inputs)", () => {
  it("accepts package gitHead when source is descriptive", () => {
    expect(() => assertFuigoCapturePin(capture, publishedRelease)).not.toThrow();
  });
  it("rejects a package gitHead that disagrees with the binary version", () => {
    expect(() => assertFuigoCapturePin(capture, { ...publishedRelease, packages: [
      { ...publishedRelease.packages[0], gitHead: "b".repeat(40) },
    ] })).toThrow("capture version must identify");
  });
  it("rejects abbreviated package commits", () => {
    expect(() => assertFuigoCapturePin(capture, { ...publishedRelease, packages: [
      { ...publishedRelease.packages[0], gitHead: source.slice(0, 12) },
    ] })).toThrow("release source must be a full commit");
  });
  it("maps version_output and files_sha256 without changing the bytes", () => {
    expect(() => assertPublishedFuigoCapture(publishedPin, publishedRelease, publishedFile, validatorBytes)).not.toThrow();
  });
  it("rejects a different capture provenance version", () => {
    expect(() => assertPublishedFuigoCapture({ ...publishedPin, version: "1.0.42" }, publishedRelease, publishedFile, validatorBytes)).toThrow("capture provenance must identify");
  });
  it("rejects a different full capture commit even if its binary pin matches", () => {
    expect(() => assertPublishedFuigoCapture({ ...publishedPin, source_commit: "b".repeat(40) }, publishedRelease, publishedFile, validatorBytes)).toThrow("capture provenance must bind");
  });
  it("requires the published package gitHead even when source is a full commit", () => {
    expect(() => assertPublishedFuigoCapture(publishedPin, release, publishedFile, validatorBytes)).toThrow("published package must pin the full commit");
  });
  it("rejects missing frame hashes", () => {
    expect(() => assertPublishedFuigoCapture({ ...publishedPin, files_sha256: {} }, publishedRelease, publishedFile, validatorBytes)).toThrow("capture frame digest missing");
  });
  it("rejects frame bytes that differ from files_sha256", () => {
    expect(() => assertPublishedFuigoCapture(publishedPin, publishedRelease, publishedFile, Buffer.from("different validator bytes"))).toThrow("captured bytes must match");
  });
});

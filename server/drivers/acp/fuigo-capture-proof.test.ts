import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FUIGO_ASSETS } from "../../../scripts/prepare-fuigo.mjs";
import { assertFuigoCapturePin, assertPublishedFuigoCapture, assertTypedCapTurn, loadLanePin, type LanePin, type PublishedCapturePin, type ReleasePin } from "../../testing/fuigo-capture-proof.ts";

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
    expect(() => assertFuigoCapturePin(capture, { ...release, packages: [{ ...release.packages[0], binarySha256: "FILL\x2dAT-NPM" }] })).toThrow("release binary digest missing");
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
const publishedLane: LanePin = { release: publishedRelease, assetBinarySha256: capture.binary.sha256 };
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
    expect(() => assertPublishedFuigoCapture(publishedPin, publishedLane, publishedFile, validatorBytes)).not.toThrow();
  });
  it("rejects a different capture provenance version", () => {
    expect(() => assertPublishedFuigoCapture({ ...publishedPin, version: "1.0.42" }, publishedLane, publishedFile, validatorBytes)).toThrow("capture provenance must identify");
  });
  it("rejects a different full capture commit even if its binary pin matches", () => {
    expect(() => assertPublishedFuigoCapture({ ...publishedPin, source_commit: "b".repeat(40) }, publishedLane, publishedFile, validatorBytes)).toThrow("capture provenance must bind");
  });
  it("requires the published package gitHead even when source is a full commit", () => {
    expect(() => assertPublishedFuigoCapture(publishedPin, publishedLane, publishedFile, validatorBytes, release)).toThrow("published package must pin the full commit");
  });
  it("rejects missing frame hashes", () => {
    expect(() => assertPublishedFuigoCapture({ ...publishedPin, files_sha256: {} }, publishedLane, publishedFile, validatorBytes)).toThrow("capture frame digest missing");
  });
  it("rejects frame bytes that differ from files_sha256", () => {
    expect(() => assertPublishedFuigoCapture(publishedPin, publishedLane, publishedFile, Buffer.from("different validator bytes"))).toThrow("captured bytes must match");
  });
});

// Lane authority (F2). Receipts are the real committed ones; lane variants are
// synthetic and labelled. The frame bytes here are validator input only, so the
// real provenance is given a digest for them: these never replay a capture.
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const laneReceipt: ReleasePin = readJson("../../../scripts/fuigo-1.0.43-provenance.json");
const dropReceipt: ReleasePin = readJson("./__fixtures__/fuigo-1.0.43/scripts/fuigo-1.0.43-provenance.json");
const realPin: PublishedCapturePin = { ...readJson("./__fixtures__/fuigo-1.0.43/PROVENANCE-1.0.43.json"),
  files_sha256: { [publishedFile]: createHash("sha256").update(validatorBytes).digest("hex") } };
const laneAsset = FUIGO_ASSETS["linux-x64"].binarySha256;
const realLane: LanePin = { release: laneReceipt, assetBinarySha256: laneAsset };
const withLinux = (receipt: ReleasePin, change: Partial<ReleasePin["packages"][number]>): ReleasePin => ({ ...receipt,
  packages: receipt.packages.map(pkg => pkg.target === "linux-x64" ? { ...pkg, ...change } : pkg) });
const check = (lane: LanePin, drop?: ReleasePin) => () => assertPublishedFuigoCapture(realPin, lane, publishedFile, validatorBytes, drop);
describe("R3 lane pin authority (real receipts, synthetic lane variants)", () => {
  it("accepts the real lane pin with and without the drop receipt", () => {
    expect(check(realLane, dropReceipt)).not.toThrow();
    expect(check(realLane)).not.toThrow();
  });
  it("W2a: an unfilled lane pin is OPEN even when the drop receipt is filled", () => {
    expect(check({ release: laneReceipt, assetBinarySha256: "FILL\x2dAT-NPM" }, dropReceipt)).toThrow("OPEN R3: lane 1.0.43 linux-x64 pin unfilled");
  });
  it("W2b: a lane pin for another binary rejects the capture", () => {
    const other = "b".repeat(64);
    expect(check({ release: withLinux(laneReceipt, { binarySha256: other }), assetBinarySha256: other }, dropReceipt)).toThrow("capture binary must match the lane 1.0.43 pin");
  });
  it("W2c: FUIGO_ASSETS and the lane receipt must agree", () => {
    expect(check({ release: withLinux(laneReceipt, { binarySha256: "b".repeat(64) }), assetBinarySha256: laneAsset }, dropReceipt)).toThrow("lane FUIGO_ASSETS pin and lane receipt disagree");
  });
  it("W2d: a lane commit differing only after the short prefix rejects the capture", () => {
    const commit = laneReceipt.source.slice(0, 39) + (laneReceipt.source.endsWith("0") ? "1" : "0");
    expect(commit.slice(0, 12)).toBe(laneReceipt.source.slice(0, 12));
    expect(check({ release: { ...laneReceipt, source: commit }, assetBinarySha256: laneAsset }, dropReceipt)).toThrow("capture provenance must bind the lane release commit");
  });
  it("W2e: loadLanePin reads the repository receipt and FUIGO_ASSETS", () => {
    const lane = loadLanePin();
    expect(lane.release).toEqual(laneReceipt);
    expect(lane.assetBinarySha256).toBe(laneAsset);
    expect(lane.release).not.toEqual(dropReceipt);
  });
  it("W7a: a drop receipt for another binary is a disagreement, never the pin", () => {
    expect(check(realLane, withLinux(dropReceipt, { binarySha256: "b".repeat(64) }))).toThrow("drop receipt disagrees with the lane pin");
  });
  it("W7b: a drop receipt for another commit is a disagreement", () => {
    expect(check(realLane, withLinux(dropReceipt, { gitHead: "b".repeat(40) }))).toThrow("drop receipt disagrees with the lane pin");
  });
});

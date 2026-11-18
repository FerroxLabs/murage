import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FUIGO_ASSETS } from "../../scripts/prepare-fuigo.mjs";
import { gatewayBusy, type LimitTurn } from "../limit-continuation.ts";

export type CapturePin = { binary: { version: string; sha256: string } };
export type ReleasePin = {
  version: string;
  source: string;
  packages: Array<{ target: string; name: string; binarySha256?: string; gitHead?: string }>;
};

/** Test support: release identity must come from the independent bundle receipt. */
export function assertFuigoCapturePin(capture: CapturePin, release: ReleasePin): void {
  assert.equal(release.version, "1.0.43", "R3 requires the independent 1.0.43 release receipt");
  const packages = release.packages.filter(pkg => pkg.target === "linux-x64" && pkg.name === "@fuigo/linux-x64");
  assert.equal(packages.length, 1, "release must pin exactly one Linux x64 binary");
  // Published receipts describe `source` in prose; npm records the full commit
  // on the platform package. Older test receipts use the full source directly.
  const source = packages[0].gitHead ?? release.source;
  assert.match(source, /^[a-f0-9]{40}$/, "release source must be a full commit");
  const version = /^fuigo 1\.0\.43 \(([a-f0-9]{7,40})\)$/.exec(capture.binary.version);
  assert.ok(version && source.startsWith(version[1]), "capture version must identify the pinned release source");
  assert.match(packages[0].binarySha256 ?? "", /^[a-f0-9]{64}$/, "release binary digest missing");
  assert.equal(capture.binary.sha256, packages[0].binarySha256, "capture binary must match the authoritative release digest");
}

export type PublishedCapturePin = {
  version: string;
  source_commit: string;
  binary: { version_output: string; sha256: string };
  files_sha256: Record<string, string>;
};

/** The lane's own pin: the repo release receipt plus the bundled asset digest. */
export type LanePin = { release: ReleasePin; assetBinarySha256: string };

const sha256Hex = /^[a-f0-9]{64}$/;
const fullCommit = /^[a-f0-9]{40}$/;
const linuxPackages = (release: ReleasePin) => release.packages.filter(pkg => pkg.target === "linux-x64" && pkg.name === "@fuigo/linux-x64");

function assertLanePinFilled(assetBinarySha256: string): void {
  assert.match(assetBinarySha256, sha256Hex, "OPEN R3: lane 1.0.43 linux-x64 pin unfilled");
}

/** Authority for R3: read from the repository, never from a capture directory. */
export function loadLanePin(): LanePin {
  const release = JSON.parse(readFileSync(new URL("../../scripts/fuigo-1.0.43-provenance.json", import.meta.url), "utf8")) as ReleasePin;
  const assetBinarySha256 = FUIGO_ASSETS["linux-x64"]?.binarySha256 ?? "";
  assertLanePinFilled(assetBinarySha256);
  return { release, assetBinarySha256 };
}

/**
 * Map the published drop explicitly; never rewrite or manufacture frame bytes.
 * The lane pin is the only authority. A receipt shipped beside the capture is
 * optional and can only add a disagreement, never supply the pin.
 */
export function assertPublishedFuigoCapture(pin: PublishedCapturePin, lane: LanePin, file: string, bytes: Uint8Array, dropRelease?: ReleasePin): void {
  assert.equal(pin.version, "1.0.43", "capture provenance must identify 1.0.43");
  assertLanePinFilled(lane.assetBinarySha256);
  const lanePackages = linuxPackages(lane.release);
  assert.equal(lanePackages.length, 1, "release must pin exactly one Linux x64 binary");
  assert.equal(lanePackages[0].binarySha256, lane.assetBinarySha256, "lane FUIGO_ASSETS pin and lane receipt disagree");
  const laneCommit = lanePackages[0].gitHead ?? lane.release.source;
  assert.match(laneCommit, fullCommit, "release source must be a full commit");
  assert.equal(pin.source_commit, laneCommit, "capture provenance must bind the lane release commit");
  assert.equal(pin.binary.sha256, lane.assetBinarySha256, "capture binary must match the lane 1.0.43 pin");
  assertFuigoCapturePin({ binary: { version: pin.binary.version_output, sha256: pin.binary.sha256 } }, lane.release);
  if (dropRelease !== undefined) {
    const dropPackages = linuxPackages(dropRelease);
    assert.equal(dropPackages.length, 1, "release must pin exactly one Linux x64 binary");
    assert.match(dropPackages[0].gitHead ?? "", fullCommit, "published package must pin the full commit");
    assert.equal(dropPackages[0].gitHead, laneCommit, "drop receipt disagrees with the lane pin");
    assert.equal(dropPackages[0].binarySha256, lane.assetBinarySha256, "drop receipt disagrees with the lane pin");
  }
  assert.match(pin.files_sha256[file] ?? "", sha256Hex, "capture frame digest missing");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.files_sha256[file], "captured bytes must match the provenance digest");
}

export function assertTypedCapTurn(turn: Pick<LimitTurn, "driverKind" | "viaGateway" | "errorText" | "gatewayCode" | "httpStatus">): void {
  assert.equal(turn.httpStatus, 429);
  assert.equal(turn.gatewayCode, "free_cap_reached", "R3 requires typed state to reach LimitTurns without legacy classification");
  assert.equal(gatewayBusy({ ...turn, errorText: "" }, { resetsAt: null }), "freeCap");
}

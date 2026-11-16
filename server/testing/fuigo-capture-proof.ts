import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

/** Map the published drop explicitly; never rewrite or manufacture frame bytes. */
export function assertPublishedFuigoCapture(pin: PublishedCapturePin, release: ReleasePin, file: string, bytes: Uint8Array): void {
  assert.equal(pin.version, "1.0.43", "capture provenance must identify 1.0.43");
  assertFuigoCapturePin({ binary: { version: pin.binary.version_output, sha256: pin.binary.sha256 } }, release);
  const pkg = release.packages.find(pkg => pkg.target === "linux-x64" && pkg.name === "@fuigo/linux-x64")!;
  assert.match(pkg.gitHead ?? "", /^[a-f0-9]{40}$/, "published package must pin the full commit");
  assert.equal(pin.source_commit, pkg.gitHead, "capture provenance must bind the full release commit");
  assert.match(pin.files_sha256[file] ?? "", /^[a-f0-9]{64}$/, "capture frame digest missing");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.files_sha256[file], "captured bytes must match the provenance digest");
}

export function assertTypedCapTurn(turn: Pick<LimitTurn, "driverKind" | "viaGateway" | "errorText" | "gatewayCode" | "httpStatus">): void {
  assert.equal(turn.httpStatus, 429);
  assert.equal(turn.gatewayCode, "free_cap_reached", "R3 requires typed state to reach LimitTurns without legacy classification");
  assert.equal(gatewayBusy({ ...turn, errorText: "" }, { resetsAt: null }), "freeCap");
}

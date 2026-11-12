import assert from "node:assert/strict";
import { gatewayBusy, type LimitTurn } from "../limit-continuation.ts";

export type CapturePin = { binary: { version: string; sha256: string } };
export type ReleasePin = {
  version: string;
  source: string;
  packages: Array<{ target: string; name: string; binarySha256?: string }>;
};

/** Test support: release identity must come from the independent bundle receipt. */
export function assertFuigoCapturePin(capture: CapturePin, release: ReleasePin): void {
  assert.equal(release.version, "1.0.42", "R3 requires the independent 1.0.42 release receipt");
  assert.match(release.source, /^[a-f0-9]{40}$/, "release source must be a full commit");
  const version = /^fuigo 1\.0\.42 \(([a-f0-9]{7,40})\)$/.exec(capture.binary.version);
  assert.ok(version && release.source.startsWith(version[1]), "capture version must identify the pinned release source");
  const packages = release.packages.filter(pkg => pkg.target === "linux-x64" && pkg.name === "@fuigo/linux-x64");
  assert.equal(packages.length, 1, "release must pin exactly one Linux x64 binary");
  assert.match(packages[0].binarySha256 ?? "", /^[a-f0-9]{64}$/, "release binary digest missing");
  assert.equal(capture.binary.sha256, packages[0].binarySha256, "capture binary must match the authoritative release digest");
}

export function assertTypedCapTurn(turn: Pick<LimitTurn, "driverKind" | "viaGateway" | "errorText" | "gatewayCode" | "httpStatus">): void {
  assert.equal(turn.httpStatus, 429);
  assert.equal(turn.gatewayCode, "free_cap_reached", "R3 requires typed state to reach LimitTurns without legacy classification");
  assert.equal(gatewayBusy({ ...turn, errorText: "" }, { resetsAt: null }), "freeCap");
}

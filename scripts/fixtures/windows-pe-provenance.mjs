// Synthetic provenance/trust setup only; production receipts are supplied by trusted CI.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { windowsPeSourcePinId } from "../windows-pe-signing.mjs";
export const fixturePeSha = bytes => createHash("sha256").update(bytes).digest("hex");
export const fixtureRevision = "a".repeat(40);
export function fixturePeSource(name, bytes, overrides = {}) {
  return { path: name, target: "win32-x64", component: "fixture-vendor", version: "1.0.0", kind: "upstream",
    sourceSha256: fixturePeSha(bytes), sha256: fixturePeSha(bytes), sourceReceiptSha256: fixturePeSha("reviewed fixture receipt"),
    publishers: ["Ferrox Labs, LLC"], reason: "reviewed fixture", ...overrides };
}
export function fixturePreservedRecord(pin) {
  return { path: pin.path, target: pin.target, component: pin.component, version: pin.version, sourcePinId: windowsPeSourcePinId(pin),
    sourceSha256: pin.sourceSha256, finalSha256: pin.sourceSha256, disposition: "preserved" };
}
export const fixturePeTrust = { authenticode: async file => ({ status: readFileSync(file).readUInt32LE(232) ? "Valid" : "NotSigned",
  publisher: "Ferrox Labs, LLC", embedded: true, timestamp: true }) };

import { expect, it } from "vitest";
import { hasEmbeddedWindowsPeSignature, unsignedWindowsPePin, verifySignedWindowsPe } from "./windows-signed-pe.mjs";
import { appendPeFixtureCertificate, unsignedPeFixture } from "../scripts/fixtures/windows-pe-signing.mjs";

it.each([0x8664, 0xaa64])("preserves every original byte when appending a certificate to machine %i", machine => {
  const raw = unsignedPeFixture(machine), pin = unsignedWindowsPePin(raw), signed = appendPeFixtureCertificate(raw);
  expect(() => verifySignedWindowsPe(signed, pin)).not.toThrow();
  signed[300] ^= 1;
  expect(() => verifySignedWindowsPe(signed, pin)).toThrow("WINDOWS_PE_SIGNING_CHANGED_PAYLOAD");
});
it.each(["padding", "offset", "length", "revision", "type", "checksum-pin", "digest-pin"])("rejects malformed signing mutation: %s", change => {
  const raw = unsignedPeFixture(), pin = unsignedWindowsPePin(raw), signed = appendPeFixtureCertificate(raw);
  const certificate = signed.readUInt32LE(232);
  if (change === "padding") signed[raw.length] = 1;
  if (change === "offset") signed.writeUInt32LE(certificate + 8, 232);
  if (change === "length") signed.writeUInt32LE(8, 236);
  if (change === "revision") signed.writeUInt16LE(1, certificate + 4);
  if (change === "type") signed.writeUInt16LE(1, certificate + 6);
  if (change === "checksum-pin") pin.checksum = 1;
  if (change === "digest-pin") pin.sha256 = "f".repeat(64);
  expect(() => verifySignedWindowsPe(signed, pin)).toThrow("WINDOWS_PE_SIGNING_CHANGED_PAYLOAD");
});
it("refuses an already signed, foreign-architecture or malformed source image", () => {
  expect(() => unsignedWindowsPePin(appendPeFixtureCertificate(unsignedPeFixture()))).toThrow();
  expect(() => unsignedWindowsPePin(unsignedPeFixture(0x14c))).toThrow();
  expect(() => unsignedWindowsPePin(Buffer.from("MZ"))).toThrow();
});
it.each([600, 1100, 1536])("reconstructs code, resources and original overlay at byte %i", offset => {
  const source = unsignedPeFixture(), signed = appendPeFixtureCertificate(source), pin = unsignedWindowsPePin(source);
  expect(hasEmbeddedWindowsPeSignature(source)).toBe(false); expect(hasEmbeddedWindowsPeSignature(signed)).toBe(true);
  signed[offset] ^= 1;
  expect(() => verifySignedWindowsPe(signed, pin)).toThrow("WINDOWS_PE_SIGNING_CHANGED_PAYLOAD");
});

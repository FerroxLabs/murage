import assert from "node:assert/strict";
import test from "node:test";

import { updateErrorMessage } from "./update-errors.mjs";

test("publisher verification refusals have one exact recovery line", () => {
  for (const diagnostic of ["404", "offline", "unsupported packet", "rollback", "ENOSPC", "certificate error"]) {
    assert.equal(updateErrorMessage(Object.assign(new Error(diagnostic), { code: "ERR_MURAGE_UPDATE_VERIFICATION" })),
      "This update could not be verified, so Murage did not install it.");
  }
});

test("update failures distinguish integrity, TLS, and recoverable environment categories", () => {
  for (const [error, expected] of [
    [Object.assign(new Error("certificate chain; no space left"), { code: "ERR_UPDATER_INVALID_SIGNATURE" }), /failed verification/],
    [new Error("sha512 checksum mismatch; ENOSPC"), /failed verification/],
    [Object.assign(new Error("connection failed"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), /do not disable certificate checks/],
    [new Error("ENOSPC: write failed"), /Free some space/],
    [new Error("EACCES: permission denied"), /folder permissions/],
    [new Error("EBUSY: rename"), /file is in use/],
    [new Error("Cannot find latest-mac.yml: 404"), /missing or invalid/],
    [new Error("HTTP 503 Service Unavailable"), /connection and try again/],
  ]) assert.match(updateErrorMessage(error), expected);
  assert.equal(updateErrorMessage(new Error("unknown diagnostic")), "unknown diagnostic");
});

test("Windows signature failures name the check that failed", async () => {
  const { WINDOWS_SIGNATURE_MISMATCH_MESSAGE, WINDOWS_SIGNATURE_TIMEOUT_MESSAGE, WINDOWS_SIGNATURE_UNAVAILABLE_MESSAGE } = await import("./update-errors.mjs");
  const code = "ERR_UPDATER_INVALID_SIGNATURE";
  assert.equal(updateErrorMessage(Object.assign(new Error("Windows signature check timed out: Command failed"), { code, signatureCheck: "timeout" })), WINDOWS_SIGNATURE_TIMEOUT_MESSAGE);
  assert.equal(updateErrorMessage(Object.assign(new Error("Windows signature check timed out: Command failed"), { code })), WINDOWS_SIGNATURE_TIMEOUT_MESSAGE);
  assert.equal(updateErrorMessage(Object.assign(new Error("Windows signature verification unavailable: spawn failed"), { code })), WINDOWS_SIGNATURE_UNAVAILABLE_MESSAGE);
  assert.equal(updateErrorMessage(Object.assign(new Error("New version 1.0.4 is not signed by the application owner: raw info"), { code })), WINDOWS_SIGNATURE_MISMATCH_MESSAGE);
  for (const message of [WINDOWS_SIGNATURE_TIMEOUT_MESSAGE, WINDOWS_SIGNATURE_UNAVAILABLE_MESSAGE, WINDOWS_SIGNATURE_MISMATCH_MESSAGE]) assert.doesNotMatch(message, /—|\bsafe/i);
  assert.match(WINDOWS_SIGNATURE_TIMEOUT_MESSAGE, /^Signature check timed out/);
  assert.match(WINDOWS_SIGNATURE_MISMATCH_MESSAGE, /^Signature mismatch/);
  // A checksum mismatch is still a bad download.
  assert.match(updateErrorMessage(new Error("sha512 checksum mismatch")), /Download a fresh installer/);
});

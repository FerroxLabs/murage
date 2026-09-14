import assert from "node:assert/strict";
import test from "node:test";

import { updateErrorMessage } from "./update-errors.mjs";

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

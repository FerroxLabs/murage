// SPDX-License-Identifier: AGPL-3.0-or-later
// The one rule for AWS_KMS_REGION, shared by the Worker (src/status.ts cloudOperating) and the deploy guard (scripts/check-deploy.mjs):
// key-wrapper.ts builds https://kms.<region>.amazonaws.com/ from it, so it must be a real region name (not blank, not " ") and, when a key ARN is
// set, the ARN's own region (a key in another region is not reachable through this endpoint). Pure string checks, no network.
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
// The key forms key-wrapper/kms.ts can use: KeyId is sent as the ARN and Decrypt must echo that same ARN, so only key ARNs (single-Region UUID key
// ids and multi-Region mrk-<32 hex> key ids) work; alias ARNs come back as the key ARN and would fail the echo check.
const KEY_ARN = /^arn:aws:kms:([a-z0-9-]+):\d{12}:key\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/;
/** True when `arn` is a KMS key ARN the runtime accepts (UUID or mrk- key id). */
export function kmsKeyArnValid(arn) { return typeof arn === "string" && KEY_ARN.test(arn); }
/** The problem with this region/ARN pair, or null. */
export function kmsRegionError(region, arn) {
  if (typeof region !== "string" || !REGION.test(region)) return "aws_kms_region_invalid";
  if (typeof arn === "string" && arn !== "") {
    const m = KEY_ARN.exec(arn);
    if (!m || m[1] !== region) return "aws_kms_region_arn_mismatch";
  }
  return null;
}

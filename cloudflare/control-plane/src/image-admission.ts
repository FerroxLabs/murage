// SPDX-License-Identifier: AGPL-3.0-or-later
// Sales admission for the image policy (KMS signing design 9.8, 10.5, 12.3).
//
// Every sales-admission path (reserve, checkout, checkout resume, and the route gate in front of them) calls assertImageEpochCurrent after the
// CLOUD_SALES_OPEN switch. It answers from the image_readiness row (src/image-readiness.ts): fresh, same config and epoch as this bundle, the
// row's epoch equal to the CURRENT durable epoch (image_policy.epoch, raised before a new bundle is uploaded), and at least one arch still inside
// its valid_until. A missing, stale or mismatched row is recomputed inline; any failure holds sales with the plain capacity line.
// Existing-customer operations (power, restart, rebuild of a running home) never call this.
export { assertSalesImagesReady as assertImageEpochCurrent, readinessHold as epochHold } from "./image-readiness";

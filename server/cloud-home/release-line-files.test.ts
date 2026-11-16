// SPDX-License-Identifier: AGPL-3.0-or-later
// Release-line guard (CLOUD-HOME-ON-RELEASE): the Cloud home image pipeline files must exist on the release
// line. A merge that drops one would ship a line that cannot build, sign or check a customer image.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const IMAGE_FILES = [
  "deploy/cloud-home/build-image.sh",
  "deploy/cloud-home/finalize-customer-image.sh",
  "deploy/cloud-home/sign-image.sh",
  "deploy/cloud-home/image-release-check.sh",
  "deploy/cloud-home/image-disk-check.sh",
  "deploy/cloud-home/launchers.txt",
  "server/cloud-home/engine-repick.ts",
];

describe("the release line carries the Cloud home image pipeline", () => {
  it.each(IMAGE_FILES)("%s exists and is not empty", file => {
    expect(statSync(join(ROOT, file)).size).toBeGreaterThan(0);
  });
  it("has at least one deploy/cloud-home/image-sig*.mjs", () => {
    const sigs = readdirSync(join(ROOT, "deploy/cloud-home")).filter(name => /^image-sig.*\.mjs$/.test(name));
    expect(sigs.length).toBeGreaterThan(0);
  });
});

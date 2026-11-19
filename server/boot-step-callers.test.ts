// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md), row D5: a low-disk failure that a boot recovery's own swallowing catch caught switches the start
// to read-only and names the step. The real callers (boot-recoveries.ts) run in a normal start whose worker floor is refusing (the C1 setup), each with its
// production catch. Needs a real small filesystem (`--tmpfs /strict`, it-remote IT_DOCKER_EXTRA); skipped elsewhere.
// HEADLESS ONLY: a child process on a throwaway data dir.
import { describe, expect, it } from "vitest";
import { bootCallersChild, inStrict } from "./testing/boot-callers.ts";
import { onStrictMount } from "./testing/strict-fs.ts";

describe("D5 a caught boot failure switches the start", () => {
  it.skipIf(!onStrictMount)("recoverOwnerSends: the refusal switches the mode, names the step, and the send row is unchanged", { timeout: 180_000 }, () => {
    inStrict("d5-sends", dir => {
      const out = bootCallersChild("sends", dir);
      expect(out).toMatchObject({ startMode: "normal", verdict: "DiskFloorRefusal", readOnlyBefore: false, readOnlyAfter: true, sendRow: "dispatched" });
      expect(out.skipped).toContain("sends.purge");
      expect(out.reason).toBe("sends.purge");
    });
  });

  it.skipIf(!onStrictMount)("the venue recovery: the refusal switches the mode, names the step, and the post and its card are unchanged", { timeout: 180_000 }, () => {
    inStrict("d5-venue", dir => {
      const out = bootCallersChild("venue", dir);
      expect(out).toMatchObject({ startMode: "normal", verdict: "DiskFloorRefusal", readOnlyBefore: false, readOnlyAfter: true, venueRow: "posting", cardAnswered: null });
      expect(out.skipped).toEqual(["venue.recoverPosts"]);
      expect(out.reason).toBe("venue.recoverPosts");
    });
  });
});

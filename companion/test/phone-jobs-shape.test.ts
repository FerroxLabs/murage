import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PHONE_JOBS_TAG as DOOR_TAG, PHONE_TOKEN as DOOR_TOKEN, approvalKeyId as doorKeyId, phoneJobsMessage as doorMessage } from "../src/phone-jobs-shape.ts";
import { PHONE_JOBS_TAG, PHONE_TOKEN, phoneJobsMessage } from "../../shared/phone-jobs-contract.ts";
import { approvalKeyId } from "../../shared/phone-jobs-hash.ts";

const fixture = JSON.parse(readFileSync(join(__dirname, "../../apps/mobile/contract/phone-jobs.json"), "utf8"));

// The door cannot import shared/ (plan B8), so its twin is pinned here; only test files may import shared/.
describe("the door's phone-jobs twin", () => {
  it("keeps the tag and token pattern identical to shared and the fixture", () => {
    expect(DOOR_TAG).toBe(PHONE_JOBS_TAG);
    expect(DOOR_TAG).toBe(fixture.mint.tag);
    expect(DOOR_TOKEN.source).toBe(PHONE_TOKEN.source);
    expect(DOOR_TOKEN.flags).toBe(PHONE_TOKEN.flags);
    expect(new RegExp(fixture.token.pattern).source).toBe(DOOR_TOKEN.source);
    for (const t of fixture.token.valid) expect(DOOR_TOKEN.test(t)).toBe(true);
    for (const t of fixture.token.invalid) expect(DOOR_TOKEN.test(t)).toBe(false);
  });

  it("derives every fixture key id and refuses the wrong hashes", () => {
    for (const v of fixture.keyId.vectors) {
      expect(doorKeyId(v.point)).toBe(v.keyId);
      expect(doorKeyId(v.point)).toBe(approvalKeyId(v.point));
      expect(doorKeyId(v.point)).not.toBe(fixture.keyId.notKeyId[v.point]);
    }
    expect(doorKeyId("short")).toBeNull();
    expect(doorKeyId("A".repeat(87))).toBeNull();
  });

  it("builds the mint message byte for byte", () => {
    const v = fixture.mint.vector;
    const f = { origin: v.origin, keyId: v.keyId, nonce: v.nonce, expiresAt: v.expiresAt };
    expect(doorMessage(f)).toBe(v.message);
    expect(doorMessage(f)).toBe(phoneJobsMessage(f));
  });
});

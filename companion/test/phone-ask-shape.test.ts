import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PHONE_ASK_TAG as DOOR_TAG, PHONE_ASK_TOKEN as DOOR_TOKEN, phoneAskMessage as doorMessage } from "../src/phone-ask-shape.ts";
import { PHONE_ASK_TAG, PHONE_ASK_TOKEN, phoneAskMessage } from "../../shared/phone-ask-contract.ts";

const fixture = JSON.parse(readFileSync(join(__dirname, "../../apps/mobile/contract/phone-ask.json"), "utf8"));

// The door cannot import shared/ (plan B8), so its twin is pinned here; only test files may import shared/.
describe("the door's phone-ask twin", () => {
  it("keeps the tag and token pattern identical to shared and the fixture", () => {
    expect(DOOR_TAG).toBe(PHONE_ASK_TAG);
    expect(DOOR_TAG).toBe(fixture.mint.tag);
    expect(DOOR_TOKEN.source).toBe(PHONE_ASK_TOKEN.source);
    expect(DOOR_TOKEN.flags).toBe(PHONE_ASK_TOKEN.flags);
    expect(new RegExp(fixture.token.pattern).source).toBe(DOOR_TOKEN.source);
    for (const t of fixture.token.valid) expect(DOOR_TOKEN.test(t)).toBe(true);
    for (const t of fixture.token.invalid) expect(DOOR_TOKEN.test(t)).toBe(false);
  });

  it("builds the mint message byte for byte", () => {
    const v = fixture.mint.vector;
    const f = { origin: v.origin, keyId: v.keyId, nonce: v.nonce, expiresAt: v.expiresAt };
    expect(doorMessage(f)).toBe(v.message);
    expect(doorMessage(f)).toBe(phoneAskMessage(f));
  });
});

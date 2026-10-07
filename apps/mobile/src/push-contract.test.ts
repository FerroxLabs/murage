import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANDROID_CHANNEL, FEATURES, GENERIC, IOS_CATEGORY, parseFcmData, parseIssued, parsePayload } from "./push-contract";
import * as oracle from "../../../shared/mobile-push";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../contract/${name}`, import.meta.url), "utf8"));
const push = read("push.json") as {
  payloads: { value: unknown; valid: boolean }[];
  fcmData: { data: Record<string, string>; valid: boolean }[];
  issueTokens: { args: unknown; valid: boolean }[];
  iosCategory: Record<string, string>;
  androidChannel: Record<string, string>;
  generic: Record<string, { title: string; body: string }>;
};

describe("the phone's reading of the push contract", () => {
  it.each(push.payloads)("payload $value → $valid", (c: { value: unknown; valid: boolean }) => {
    expect(parsePayload(c.value) !== null).toBe(c.valid);
    expect(parsePayload(c.value)).toEqual(oracle.parsePushPayload(c.value));
  });
  it.each(push.fcmData)("FCM data $data → $valid", (c: { data: Record<string, string>; valid: boolean }) => {
    expect(parseFcmData(c.data) !== null).toBe(c.valid);
  });
  it("FCM data carries the thread group", () => {
    expect(parseFcmData(push.fcmData[0].data)?.threadGroup).toBe("46af17e29b1130f0");
  });
  it.each(push.issueTokens)("issuePushTokens $args → $valid", (c: { args: unknown; valid: boolean }) => {
    expect(parseIssued(c.args) !== null).toBe(c.valid);
  });
  it("categories, channels and generic text match the contract", () => {
    expect(IOS_CATEGORY).toEqual(push.iosCategory);
    expect(ANDROID_CHANNEL).toEqual(push.androidChannel);
    expect(GENERIC).toEqual(push.generic);
    expect(FEATURES).toEqual(read("push-features.json"));
  });
});

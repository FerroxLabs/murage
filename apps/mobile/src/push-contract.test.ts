import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUSH_CONTRACT_VERSION, ANDROID_CHANNEL, CALL_SOUND, EXPIRING_CATEGORIES, FEATURES, GENERIC, IOS_ACTIONS, IOS_CATEGORY, callDisplayAction, isTimeSensitive, parseFcmData, parseIssued, parsePayload } from "./push-contract";
import * as oracle from "../../../shared/mobile-push";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../contract/${name}`, import.meta.url), "utf8"));
const push = read("push.json") as {
  payloads: { value: unknown; valid: boolean }[];
  fcmData: { data: Record<string, string>; valid: boolean }[];
  issueTokens: { args: unknown; valid: boolean }[];
  iosCategory: Record<string, string>;
  androidChannel: Record<string, string>;
  generic: Record<string, { title: string; body: string }>;
  version: number;
  iosActions: Record<string, { id: string; title: string; options: string[] }[]>;
  callSound: { ios: string; android: string; seconds: number };
  expiringCategories: string[];
  callDisplay: { case: string; payload: any; now: number; shown: string[]; action: string }[];
  providerCall: { event: any; apns: { body: any }; fcm: { message: { data: Record<string, string> } } };
  provider: { event: any; apns: { body: any }; fcm: { message: { data: Record<string, string> } } };
};
const call = push.providerCall;
const other = push.provider;

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
  it("is contract v2 with the call actions, sound and expiring kinds", () => {
    expect(push.version).toBe(2);
    expect(PUSH_CONTRACT_VERSION).toBe(push.version);
    expect(oracle.PUSH_CONTRACT_VERSION).toBe(push.version);
    expect(IOS_ACTIONS).toEqual(push.iosActions);
    expect(IOS_ACTIONS.CALL[0].options).toEqual(["foreground", "authenticationRequired"]);
    expect(IOS_ACTIONS.CALL[1].options).toEqual(["authenticationRequired"]);
    expect(CALL_SOUND).toEqual(push.callSound);
    expect([...EXPIRING_CATEGORIES]).toEqual(push.expiringCategories);
    expect(IOS_CATEGORY.call).toBe("CALL");
    expect(IOS_CATEGORY["call-note"]).toBe("CALL_NOTE");
    expect(ANDROID_CHANNEL.call).toBe("calls_v2");
    expect(ANDROID_CHANNEL["call-note"]).toBe("questions");
  });
  it("expiresAt rides only the call kinds, in both directions", () => {
    for (const c of push.payloads) {
      const v = c.value as { category?: string; expiresAt?: unknown } | null;
      if (!v || typeof v !== "object" || !c.valid) continue;
      expect("expiresAt" in v).toBe(push.expiringCategories.includes(v.category as string));
    }
    for (const c of push.fcmData) {
      if (!c.valid) continue;
      expect("expiresAt" in c.data).toBe(push.expiringCategories.includes(c.data.category));
    }
    const first = parsePayload(push.payloads.find((c) => c.valid && (c.value as any).category === "call")!.value);
    expect(first?.expiresAt).toBe(1790000045000);
    const fcm = parseFcmData(call.fcm.message.data);
    expect(fcm?.expiresAt).toBe(1790000045000);
    expect(fcm?.threadGroup).toBe("46af17e29b1130f0");
    expect(parseFcmData(other.fcm.message.data)?.expiresAt).toBeUndefined();
    expect(parsePayload(other.apns.body.murage)?.expiresAt).toBeUndefined();
    expect("expiresAt" in other.apns.body.murage).toBe(false);
    expect("expiresAt" in other.fcm.message.data).toBe(false);
  });
  it("the provider call vector: CALL category, time-sensitive, call sound, expiry in aps.murage and FCM data", () => {
    const aps = call.apns.body.aps;
    expect(aps.category).toBe(IOS_CATEGORY.call);
    expect(aps["interruption-level"]).toBe("time-sensitive");
    expect(aps.sound).toBe(CALL_SOUND.ios);
    expect(aps.alert).toEqual(GENERIC.call);
    expect(isTimeSensitive("call")).toBe(true);
    expect(parsePayload(call.apns.body.murage)).toEqual(oracle.parsePushPayload(call.apns.body.murage));
    expect(call.apns.body.murage.expiresAt).toBe(call.event.expiresAt);
    expect(call.fcm.message.data.expiresAt).toBe(String(call.event.expiresAt));
    expect(call.fcm.message.data.category).toBe("call");
    expect(other.apns.body.aps.sound).toBe("default");
  });
  it.each(push.callDisplay)("callDisplay: $case", (c) => {
    const payload = parsePayload(c.payload)!;
    expect(payload).not.toBeNull();
    expect(callDisplayAction(payload, c.now, c.shown)).toBe(c.action);
    expect(callDisplayAction(payload, c.now, c.shown)).toBe(oracle.callDisplayAction(payload, c.now, c.shown));
  });
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_BLOCKED_LINE,
  PREVIEW_CARD_SUBTITLE,
  PREVIEW_COPY,
  PREVIEW_READ_FAILED,
  PREVIEW_RETRY,
  PREVIEW_SAVE_FAILED,
  PreviewReadFailed,
  PreviewSwitchRow,
  previewFlagOn,
  previewPatchBody,
  previewReason,
  type PhoneOfferAnswer,
  type PhonePreview,
} from "./PhonePreviewSwitches";

const answer = (over: Partial<PhoneOfferAnswer> = {}): PhoneOfferAnswer => ({ offered: false, flag: false, shareAsk: false, shareAskFlag: false, blocked: null, ...over });

describe("the PATCH body for each switch", () => {
  it("writes exactly one flag under features, on or off", () => {
    expect(previewPatchBody("phoneTools", true)).toEqual({ features: { phoneTools: true } });
    expect(previewPatchBody("phoneTools", false)).toEqual({ features: { phoneTools: false } });
    expect(previewPatchBody("phoneShareAsk", true)).toEqual({ features: { phoneShareAsk: true } });
    expect(previewPatchBody("phoneShareAsk", false)).toEqual({ features: { phoneShareAsk: false } });
    expect(JSON.stringify(previewPatchBody("phoneShareAsk", true))).toBe('{"features":{"phoneShareAsk":true}}');
  });
  it("the component sends it to PATCH /api/config and reads back /api/phones/offered", () => {
    const src = readFileSync(fileURLToPath(new URL("./PhonePreviewSwitches.tsx", import.meta.url)), "utf8");
    expect(src).toContain('api("/api/config", { method: "PATCH", body: JSON.stringify(previewPatchBody(which, on)) })');
    expect(src).toContain('api("/api/phones/offered")');
  });
});

describe("each switch shows its own saved flag, independent of the other", () => {
  it("phone tools reads flag, share and ask reads shareAskFlag", () => {
    expect(previewFlagOn("phoneTools", answer({ flag: true }))).toBe(true);
    expect(previewFlagOn("phoneShareAsk", answer({ flag: true }))).toBe(false);
    expect(previewFlagOn("phoneShareAsk", answer({ shareAskFlag: true }))).toBe(true);
    expect(previewFlagOn("phoneTools", answer({ shareAskFlag: true }))).toBe(false);
    expect(previewFlagOn("phoneTools", null)).toBe(false);
    // an older harness without shareAskFlag: the switch shows off rather than guessing
    expect(previewFlagOn("phoneShareAsk", { offered: true, flag: true, shareAsk: true })).toBe(false);
  });
});

describe("the reason line", () => {
  const both: PhonePreview[] = ["phoneTools", "phoneShareAsk"];
  it("is absent while the flag is off, and while the flag is on and offered", () => {
    for (const which of both) {
      expect(previewReason(which, answer({ blocked: "cloud-home" }))).toBeNull();
      expect(previewReason(which, null)).toBeNull();
    }
    expect(previewReason("phoneTools", answer({ flag: true, offered: true }))).toBeNull();
    expect(previewReason("phoneShareAsk", answer({ shareAskFlag: true, shareAsk: true }))).toBeNull();
  });
  it("names the Cloud home, the shared workspace or the launch proof while the flag is on and not offered", () => {
    expect(previewReason("phoneTools", answer({ flag: true, blocked: "cloud-home" }))).toBe(PREVIEW_BLOCKED_LINE["cloud-home"]);
    expect(previewReason("phoneTools", answer({ flag: true, blocked: "shared-workspace" }))).toBe(PREVIEW_BLOCKED_LINE["shared-workspace"]);
    expect(previewReason("phoneShareAsk", answer({ shareAskFlag: true, blocked: "launch-proof" }))).toBe(PREVIEW_BLOCKED_LINE["launch-proof"]);
    expect(previewReason("phoneShareAsk", answer({ shareAskFlag: true }))).toBe(PREVIEW_BLOCKED_LINE.unknown);
  });
  it("follows each switch's own offer: phone tools offered does not clear share and ask's line", () => {
    const a = answer({ flag: true, offered: true, shareAskFlag: true, shareAsk: false, blocked: null });
    expect(previewReason("phoneTools", a)).toBeNull();
    expect(previewReason("phoneShareAsk", a)).toBe(PREVIEW_BLOCKED_LINE.unknown);
  });
  it("keeps the switch on and shows one line under it", () => {
    const html = renderToStaticMarkup(createElement(PreviewSwitchRow, { which: "phoneTools", answer: answer({ flag: true, blocked: "shared-workspace" }), busy: false, error: false, onChange: () => {} }));
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(PREVIEW_BLOCKED_LINE["shared-workspace"]);
    expect(html.match(/data-preview-reason/g)).toHaveLength(1);
  });
});

describe("the row", () => {
  const row = (which: PhonePreview, a: PhoneOfferAnswer | null, extra: { busy?: boolean; error?: boolean } = {}) =>
    renderToStaticMarkup(createElement(PreviewSwitchRow, { which, answer: a, busy: extra.busy ?? false, error: extra.error ?? false, onChange: () => {} }));
  it("shows the label and the line, off by default, disabled until the answer arrives", () => {
    for (const which of ["phoneTools", "phoneShareAsk"] as const) {
      const html = row(which, answer());
      expect(html).toContain(PREVIEW_COPY[which].label);
      expect(html).toContain(PREVIEW_COPY[which].body.replace("'", "&#x27;"));
      expect(html).toContain('aria-checked="false"');
      expect(html).not.toMatch(/ disabled=""/);
      expect(row(which, null)).toMatch(/ disabled=""/);
    }
  });
  it("is disabled while a save runs, and a failed save says so", () => {
    expect(row("phoneTools", answer(), { busy: true })).toMatch(/ disabled=""/);
    expect(row("phoneTools", answer(), { error: true })).toContain(PREVIEW_SAVE_FAILED);
  });
});

describe("settings that could not be read", () => {
  it("says so and offers Try again", () => {
    const html = renderToStaticMarkup(createElement(PreviewReadFailed, { onRetry: () => {} }));
    expect(html).toContain(PREVIEW_READ_FAILED);
    expect(html).toContain(PREVIEW_RETRY);
  });
});

describe("copy rules", () => {
  const lines = [PREVIEW_CARD_SUBTITLE, PREVIEW_SAVE_FAILED, PREVIEW_READ_FAILED, PREVIEW_RETRY, ...Object.values(PREVIEW_BLOCKED_LINE), ...Object.values(PREVIEW_COPY).flatMap((c) => [c.label, c.body])];
  it("has no em dash, never says safe, and keeps the spec's exact switch copy", () => {
    for (const line of lines) {
      expect(line).not.toContain("—");
      expect(line.toLowerCase()).not.toMatch(/\bsafe/);
    }
    expect(PREVIEW_COPY.phoneTools).toEqual({ label: "Phone tools (preview)", body: "Let your bots check and add to this phone's calendar, reminders, contacts, alarms and rough location. You approve each request on the phone." });
    expect(PREVIEW_COPY.phoneShareAsk).toEqual({ label: "Share and ask (preview)", body: "Send things to your bots from any app on the phone, and ask them from anywhere." });
  });
});

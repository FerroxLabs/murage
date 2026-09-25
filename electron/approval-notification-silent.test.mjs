// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { APPROVAL_SOUND, approvalOptions, approvalPayload, createApprovalNotifications } from "./approval-notification.mjs";

// Upstream OpenMausBot #1274: a computer that muted notification sounds keeps
// the approval banner but not the chime.
const payload = { botId: "bot", threadId: "task", requestId: "request", messageId: "card", title: "Approval", body: "Review" };

describe("muted approval banners", () => {
  it("accepts only a boolean silent flag", () => {
    expect(approvalPayload({ ...payload, silent: true })).toEqual({ ...payload, silent: true });
    expect(approvalPayload({ ...payload, silent: "yes" })).toBeNull();
  });

  it("drops the sound on macOS and Windows when silent", () => {
    expect(approvalOptions(payload, "darwin")).toMatchObject({ sound: APPROVAL_SOUND, silent: false });
    const mac = approvalOptions(payload, "darwin", undefined, true);
    expect(mac).toMatchObject({ title: "Approval", body: "Review", silent: true });
    expect(mac.sound).toBeUndefined();
    const windows = approvalOptions(payload, "win32", undefined, true).toastXml;
    expect(windows).toMatch(/<audio silent="true"\/>/);
    expect(windows).not.toMatch(/Notification.Reminder/);
  });

  it("keeps the renderer's silent choice after the server re-reads the approval", async () => {
    const notices = [];
    class Native extends EventEmitter {
      static isSupported() { return true; }
      constructor(options) { super(); this.options = options; notices.push(this); }
      show() { this.shown = true; }
    }
    // the server's fresh copy knows nothing about this computer's sound choice
    const show = createApprovalNotifications({ Notification: Native, platform: "darwin", authorize: async () => true, revalidate: async () => ({ ...payload }), onOpen() {} });
    expect(await show({ ...payload, silent: true })).toEqual({ accepted: true });
    expect(notices[0].options).toMatchObject({ silent: true });
    expect(notices[0].options.sound).toBeUndefined();
  });
});

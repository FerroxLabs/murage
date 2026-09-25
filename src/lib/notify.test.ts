import { afterEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({ enabled: true }));
vi.mock("./notification-sounds", () => ({
  notificationSoundsEnabled: () => sounds.enabled,
}));

import {
  buildNotificationOptions,
  createApprovalDeduper,
  requestNotificationPermission,
  showNotification,
  type NotifyFrame,
} from "./notify";

const frame: NotifyFrame = {
  kind: "done",
  botId: "bot-1",
  botName: "Ember",
  threadId: "thread-1",
  title: "Ember finished",
  body: "All done",
};

function installNotification(permission: NotificationPermission, focused = false) {
  const notices: Array<{ title: string; options?: NotificationOptions; onclick: (() => void) | null }> = [];
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  class FakeNotification {
    static permission = permission;
    static requestPermission = requestPermission;
    onclick: (() => void) | null = null;
    constructor(public title: string, public options?: NotificationOptions) {
      notices.push(this);
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.stubGlobal("document", { hasFocus: () => focused });
  vi.stubGlobal("window", { focus: vi.fn() });
  return { notices, requestPermission };
}

afterEach(() => {
  vi.unstubAllGlobals();
  sounds.enabled = true;
});

describe("desktop notifications", () => {
  it("delivers a fresh focused approval through the native bridge once", () => {
    const { notices } = installNotification("granted", true);
    const show = vi.fn(async () => ({ accepted: true }));
    Object.assign(window, { muragebox: { platform: "darwin", approvalNotifications: { show } } });
    const approval = { ...frame, kind: "approval" as const, requestId: "focused-approval", messageId: "card" };
    showNotification(approval, vi.fn(), undefined, frame.threadId);
    showNotification(approval, vi.fn(), undefined, frame.threadId);
    expect(show).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith({ botId: frame.botId, threadId: frame.threadId, requestId: approval.requestId, messageId: "card", title: frame.title, body: frame.body });
    expect(notices).toHaveLength(0);
  });
  it("delivers an image approval (no turn id) through the native bridge once, even while its thread is on screen", () => {
    const { notices } = installNotification("granted", true);
    const show = vi.fn(async () => ({ accepted: true }));
    Object.assign(window, { muragebox: { platform: "darwin", approvalNotifications: { show } } });
    const approval = { ...frame, kind: "approval" as const, requestId: "image-9b0e", messageId: "image-card", title: "Ember needs approval", body: "One image · flux" };
    showNotification(approval, vi.fn(), undefined, frame.threadId);
    showNotification(approval, vi.fn(), undefined, frame.threadId);
    expect(show).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith({ botId: frame.botId, threadId: frame.threadId, requestId: "image-9b0e", messageId: "image-card", title: approval.title, body: approval.body });
    expect(notices).toHaveLength(0);
  });
  it.each(["default", "denied"] as const)("does not deliver an approval with permission %s", permission => {
    const { notices } = installNotification(permission, true);
    const show = vi.fn();
    Object.assign(window, { muragebox: { platform: "darwin", approvalNotifications: { show } } });
    showNotification({ ...frame, kind: "approval", requestId: `permission-${permission}`, messageId: "card" }, vi.fn());
    expect(show).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
  });
  it("does not retry a failing native alert through an audible web fallback", async () => {
    const { notices } = installNotification("granted");
    const show = vi.fn(async () => { throw new Error("native refused"); });
    Object.assign(window, { muragebox: { platform: "win32", approvalNotifications: { show } } });
    const approval = { ...frame, kind: "approval" as const, requestId: "failed-native", messageId: "card" };
    showNotification(approval, vi.fn());
    await Promise.resolve();
    showNotification(approval, vi.fn());
    expect(show).toHaveBeenCalledOnce();
    expect(notices).toHaveLength(0);
  });
  it("does not request permission from a background notification frame", () => {
    const { notices, requestPermission } = installNotification("default");
    showNotification(frame, vi.fn());
    expect(requestPermission).not.toHaveBeenCalled();
    expect(notices).toHaveLength(0);
  });

  it("requests permission through the explicit settings action", async () => {
    const { requestPermission } = installNotification("default");
    await requestNotificationPermission();
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("shows a notification after permission is granted", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ title: frame.title, options: { body: frame.body, tag: `murage:${frame.botId}` } });
  });

  it("stays quiet only when the exact target thread is already visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, frame.threadId);

    expect(notices).toHaveLength(0);
  });

  it("still alerts a focused app when another task is visible", () => {
    const { notices } = installNotification("granted", true);

    showNotification(frame, vi.fn(), undefined, "another-thread");

    expect(notices).toHaveLength(1);
  });

  it("opens the exact detached task carried by the notification", () => {
    const { notices } = installNotification("granted");
    const onOpen = vi.fn();

    showNotification({ ...frame, threadId: "detached-routine-thread" }, onOpen);
    notices[0]!.onclick?.();

    expect(window.focus).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith({
      botId: frame.botId,
      threadId: "detached-routine-thread",
    });
  });

  it("does not reintroduce a profile image into private lock-screen previews", () => {
    const { notices } = installNotification("granted");
    const onOpen = vi.fn();
    showNotification({ ...frame, title: "Murage", body: "Open Murage to review.", botName: "", privatePreview: true }, onOpen, "https://example.com/private-avatar.png");
    expect(notices[0].options?.icon).toBeUndefined();
    expect(notices[0].title).toBe("Murage");
    notices[0].onclick?.();
    expect(onOpen).toHaveBeenCalledWith({ botId: frame.botId, threadId: frame.threadId });
  });

  it("groups under the bot, not the thread", () => {
    const { notices } = installNotification("granted");

    showNotification(frame, vi.fn());
    showNotification(
      { ...frame, threadId: "thread-2", body: "Second task done" },
      vi.fn(),
    );

    // one bot across two threads shares a tag, so the platform replaces
    // rather than stacks; another bot gets its own key
    expect(notices[0]?.options?.tag).toBe(`murage:${frame.botId}`);
    expect(notices[1]?.options?.tag).toBe(`murage:${frame.botId}`);
    showNotification({ ...frame, botId: "bot-2" }, vi.fn());
    expect(notices[2]?.options?.tag).toBe(`murage:bot-2`);
  });

  it("carries the bot's avatar when its profile has one", () => {
    const { notices } = installNotification("granted");
    const avatarUrl = "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png";

    showNotification(frame, vi.fn(), avatarUrl);
    expect(notices[0]?.options?.icon).toBe(avatarUrl);

    showNotification(frame, vi.fn(), null);
    expect(notices[1]?.options?.icon).toBeUndefined();
  });
});

it("dedupes request identity rather than copy, with bounded recent retention", () => {
  const claim = createApprovalDeduper(2);
  const approval = { ...frame, kind: "approval" as const, requestId: "same-id", messageId: "card" };
  expect(claim(approval)).toBe(true);
  expect(claim({ ...approval, body: "changed", messageId: "duplicate-card" })).toBe(false);
  expect(claim({ ...approval, threadId: "different" })).toBe(true);
  expect(claim({ ...approval, requestTurnId: "next-turn" })).toBe(true);
  expect(claim(approval)).toBe(true);
  expect(claim({ ...approval, botId: "other-bot" })).toBe(true);
  expect(claim({ ...approval, requestId: undefined })).toBe(false);
});

describe("buildNotificationOptions", () => {
  it("keys coalescing on botId and omits a missing avatar", () => {
    expect(buildNotificationOptions({ id: "bot-9" })).toEqual({
      tag: "murage:bot-9",
      icon: undefined,
    });
  });
});

// Upstream OpenMausBot #1274: someone on a call with a bot hears it talk, then
// the platform's chime for the same reply. This computer can mute the sound
// and keep the banner.
describe("notification sounds", () => {
  it("lets the platform play its sound by default", () => {
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices[0]?.options?.silent).toBeUndefined();
  });

  it("posts silently when sounds are muted on this computer, keeping the banner", () => {
    sounds.enabled = false;
    const { notices } = installNotification("granted");
    showNotification(frame, vi.fn());
    expect(notices).toHaveLength(1);
    expect(notices[0]?.options).toMatchObject({ body: frame.body, silent: true });
  });

  it("asks the native approval banner to stay silent too", () => {
    sounds.enabled = false;
    installNotification("granted");
    const show = vi.fn(async () => ({ accepted: true }));
    Object.assign(window, { muragebox: { platform: "darwin", approvalNotifications: { show } } });
    const approval = { ...frame, kind: "approval" as const, requestId: "muted-approval", messageId: "card" };
    showNotification(approval, vi.fn());
    expect(show).toHaveBeenCalledWith({ botId: frame.botId, threadId: frame.threadId, requestId: "muted-approval", messageId: "card", title: frame.title, body: frame.body, silent: true });
  });
});

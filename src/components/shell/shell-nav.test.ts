// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// openChat from Today and Needs you: the bot's own conversation is a plain
// pick; another of its conversations (a background task, a routine's run) is
// switched to first, the way an Inbox link does (Astra r1 High).
import { beforeEach, describe, expect, it, vi } from "vitest";

const openInboxLink = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
vi.mock("@/lib/open-inbox-link", () => ({ openInboxLink: (...args: unknown[]) => openInboxLink(...args) }));

const { shellNav } = await import("./shell-nav");

const state = { bots: [{ id: "b1", threadId: "t-main" }], groups: [], pageIntent: undefined } as never;

describe("openChat", () => {
  beforeEach(() => openInboxLink.mockClear());

  it("picks the bot when no conversation is named, or the named one is already open", () => {
    const dispatch = vi.fn();
    const nav = shellNav(dispatch, () => state);
    nav.openChat("b1");
    nav.openChat("b1", "t-main");
    expect(dispatch.mock.calls).toEqual([[{ type: "select", id: "b1" }], [{ type: "select", id: "b1" }]]);
    expect(openInboxLink).not.toHaveBeenCalled();
  });

  it("switches the bot to another of its conversations before showing it", () => {
    const dispatch = vi.fn();
    shellNav(dispatch, () => state).openChat("b1", "t-task");
    expect(openInboxLink).toHaveBeenCalledWith({ threadId: "t-task" }, state, dispatch);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("opens the bot where it is when the switch is refused", async () => {
    openInboxLink.mockRejectedValueOnce(new Error("gone"));
    const dispatch = vi.fn();
    shellNav(dispatch, () => state).openChat("b1", "t-task");
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "b1" }));
  });
});

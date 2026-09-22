import { describe, expect, it } from "vitest";

import {
  sidebarAttentionLabel,
  sidebarBotMark,
  sidebarGroupMark,
  sidebarMarkLabel,
  sidebarMarkNameClass,
  sidebarMarkRowClass,
  sidebarSectionAttention,
} from "./sidebar-attention";

describe("collapsed sidebar attention", () => {
  it("keeps unread chats and approval waits visible at the section level", () => {
    const attention = sidebarSectionAttention(
      [
        { unread: true, activity: "waiting-on-you" },
        { busy: true, activity: "working" },
      ],
      [{ unread: true }, { busyBotId: "writer" }],
    );

    expect(attention).toEqual({ unread: 2, waiting: 1, working: 2 });
    expect(sidebarAttentionLabel(attention)).toBe(
      "1 waiting for you, 2 unread, 2 working",
    );
  });

  it("does not count a waiting bot twice as working", () => {
    expect(
      sidebarSectionAttention([{ busy: true, activity: "waiting-on-you" }], []),
    ).toEqual({ unread: 0, waiting: 1, working: 0 });
  });
});

describe("one row, one mark", () => {
  it("spends the mark on waiting, even when the row is also unread and busy", () => {
    expect(
      sidebarBotMark({ unread: true, busy: true, activity: "waiting-on-you" }),
    ).toEqual({ kind: "waiting", count: 1 });
  });

  it("counts the threads that are waiting, not the ones that are not", () => {
    expect(
      sidebarBotMark({
        activity: "waiting-on-you",
        tasks: [
          { activity: "waiting-on-you" },
          { activity: "working" },
          { activity: "waiting-on-you" },
          { activity: "idle" },
        ],
      }),
    ).toEqual({ kind: "waiting", count: 2 });
  });

  it("still counts one when the bot waits without a loaded task list", () => {
    expect(sidebarBotMark({ activity: "waiting-on-you" })).toEqual({ kind: "waiting", count: 1 });
    expect(sidebarBotMark({ activity: "waiting-on-you", tasks: [] })).toEqual({
      kind: "waiting",
      count: 1,
    });
  });

  it("marks working above unread, and unread above nothing", () => {
    expect(sidebarBotMark({ activity: "working", unread: true })).toEqual({ kind: "working" });
    expect(sidebarBotMark({ busy: true, unread: true })).toEqual({ kind: "working" });
    expect(sidebarBotMark({ unread: true })).toEqual({ kind: "unread" });
    expect(sidebarBotMark({})).toEqual({ kind: "none" });
    expect(sidebarBotMark({ activity: "idle" })).toEqual({ kind: "none" });
  });

  it("gives a channel the same ladder, minus a decision it cannot hold", () => {
    expect(sidebarGroupMark({ busyBotId: "writer", unread: true })).toEqual({ kind: "working" });
    expect(sidebarGroupMark({ unread: true })).toEqual({ kind: "unread" });
    expect(sidebarGroupMark({ busyBotId: null })).toEqual({ kind: "none" });
  });
});

describe("what the row says when it cannot say it in colour", () => {
  it("names every state, so a screen reader learns what the eye no longer sees", () => {
    expect(sidebarMarkLabel({ kind: "waiting", count: 1 })).toBe("Waiting for you");
    expect(sidebarMarkLabel({ kind: "waiting", count: 3 })).toBe("3 waiting for you");
    expect(sidebarMarkLabel({ kind: "working" })).toBe("Working");
    expect(sidebarMarkLabel({ kind: "unread" })).toBe("Unread");
    expect(sidebarMarkLabel({ kind: "none" })).toBe("");
  });

  it("carries unread in the name's weight, and dims a row with nothing to say", () => {
    expect(sidebarMarkNameClass({ kind: "unread" })).toContain("font-bold");
    for (const mark of [
      { kind: "waiting", count: 2 } as const,
      { kind: "working" } as const,
      { kind: "none" } as const,
    ]) {
      expect(sidebarMarkNameClass(mark)).not.toContain("font-bold");
    }
    expect(sidebarMarkNameClass({ kind: "none" })).toContain("text-ink/70");
    expect(sidebarMarkNameClass({ kind: "unread" })).not.toContain("text-ink/70");
  });

  it("tints the row for waiting and for nothing else", () => {
    expect(sidebarMarkRowClass({ kind: "waiting", count: 1 })).toContain("bg-warning/10");
    expect(sidebarMarkRowClass({ kind: "working" })).toBe("");
    expect(sidebarMarkRowClass({ kind: "unread" })).toBe("");
    expect(sidebarMarkRowClass({ kind: "none" })).toBe("");
  });
});

// Who may start a call with which bot. The desktop may call any bot, as it
// always has. A phone the companion proved it forwarded may call the bots
// its sidebar shows and no others. Nothing unproven may call at all.
import { describe, expect, it } from "vitest";

import type { InboxRosterStore } from "../inbox-access.ts";
import { callAccess, callTargetAccess, callSourceVisible } from "./call-access.ts";

function world(): InboxRosterStore {
  const bots = [
    { id: "open", name: "Open", threadId: "t-open", tasks: [] },
    { id: "secret", name: "Secret", threadId: "t-secret", hidden: true, tasks: [] },
  ];
  const groups: InboxRosterStore["groups"] = [];
  return {
    bots, groups,
    bot: id => bots.find(bot => bot.id === id) ?? null,
    botByThread: threadId => bots.find(bot => bot.threadId === threadId) ?? null,
    group: () => undefined,
    groupByThread: () => undefined,
  };
}

describe("call access", () => {
  it("lets the desktop call any bot, hidden ones included", () => {
    expect(callAccess(world(), "desktop", "open")).toBe("allowed");
    expect(callAccess(world(), "desktop", "secret")).toBe("allowed");
  });

  it("lets a proven phone call only the bots its sidebar shows", () => {
    expect(callAccess(world(), "companion", "open")).toBe("allowed");
    // A hidden bot answers exactly like a bot that does not exist, so a phone
    // cannot learn it is there by probing ids.
    expect(callAccess(world(), "companion", "secret")).toBe("not-found");
    expect(callAccess(world(), "companion", "nobody")).toBe("not-found");
  });

  it("refuses anything unproven, whatever bot it names", () => {
    expect(callAccess(world(), "unproven", "open")).toBe("forbidden");
    expect(callAccess(world(), "unproven", "nobody")).toBe("forbidden");
  });
});

describe("D24 P-call-admission", () => {
  it("binds direct sessions to their real thread and retains phone direct access", () => {
    for (const door of ["desktop", "companion"] as const) {
      expect(callTargetAccess(world(), door, "open", "t-open")).toBe("allowed");
      expect(callTargetAccess(world(), door, "open", "t-secret")).toBe("not-found");
    }
    expect(callTargetAccess(world(), "unproven", "open", "t-open")).toBe("forbidden");
  });
  it("rejects phone room calls and forged room threads on direct sessions", () => {
    const group = { id: "room", name: "Room", threadId: "t-room", memberIds: ["open"], hidden: false };
    const store = { ...world(), groups: [group] };
    store.group = id => id === "room" ? group : undefined;
    store.groupByThread = id => id === "t-room" ? group : undefined;
    expect(callTargetAccess(store, "desktop", "room", "t-room")).toBe("allowed");
    expect(callTargetAccess(store, "companion", "room", "t-room")).toBe("not-found");
    expect(callTargetAccess(store, "desktop", "room", "t-room", false)).toBe("not-found");
    expect(callTargetAccess(store, "desktop", "open", "t-room")).toBe("not-found");
    expect(callTargetAccess(store, "companion", "open", "t-room")).toBe("not-found");
    expect(callTargetAccess(store, "desktop", "room", "t-open")).toBe("not-found");
    store.group = () => ({ ...group, hidden: true });
    expect(callTargetAccess(store, "desktop", "room", "t-room")).toBe("not-found");
  });
});


it("D24 live source authorization follows phone visibility while retaining desktop hidden-bot access", () => {
  const store = world();
  const phone = { targetId: "open", threadId: "t-open", desktop: false };
  expect(callSourceVisible(store, phone, "open")).toBe(true);
  Object.assign(store.bot("open")!, { hidden: true });
  expect(callSourceVisible(store, phone, "open")).toBe(false);
  expect(callSourceVisible(store, { ...phone, desktop: true }, "open")).toBe(true);
  expect(callSourceVisible(store, { ...phone, desktop: true }, "secret")).toBe(false);
});

// Who may start a call with which bot. The desktop may call any bot, as it
// always has. A phone the companion proved it forwarded may call the bots
// its sidebar shows and no others. Nothing unproven may call at all.
import { describe, expect, it } from "vitest";

import type { InboxRosterStore } from "../inbox-access.ts";
import { callAccess } from "./call-access.ts";

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

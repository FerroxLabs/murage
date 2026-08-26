import { describe, expect, it } from "vitest";

import { unreadConversationCount } from "./unread";

describe("unreadConversationCount", () => {
  it("counts visible bot and room conversations but ignores archived bots", () => {
    expect(
      unreadConversationCount(
        [{ unread: true }, { unread: false }, { unread: true, hidden: true }],
        [{ unread: true }, { unread: false }],
      ),
    ).toBe(2);
  });
});

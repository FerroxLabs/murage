import { describe, expect, it } from "vitest";

import { GROUP_CONTEXT_MESSAGES, roomContextMessageIds, roomContextMessages } from "./room-context.ts";
import type { Message } from "./store.ts";

// The pinned message used to be the one message that reliably never reached
// the prompt. The window is the newest thirty, and a pin earns its keep by
// being older than that, so the thing the person asked the room to keep in
// mind was the thing the room could not see.

type Line = { id: string; kind: Message["kind"]; text?: string };

const text = (id: string): Line => ({ id, kind: "text", text: id });
/** A long room: the pin is at the very top and forty messages have happened
 *  since, so it is well outside the window. */
const long = (): Line[] => [text("pin"), ...Array.from({ length: 40 }, (_, index) => text(`m${index}`))];

describe("the pinned message reaches the prompt", () => {
  it("is not there at all without the pin, which is the bug", () => {
    expect(roomContextMessages(long()).map((m) => m.id)).not.toContain("pin");
  });

  it("is carried in front of the window once the pin is passed in", () => {
    const selected = roomContextMessages(long(), GROUP_CONTEXT_MESSAGES, "pin").map((m) => m.id);
    expect(selected[0]).toBe("pin");
    expect(selected).toHaveLength(GROUP_CONTEXT_MESSAGES + 1);
    expect(selected.filter((id) => id === "pin")).toHaveLength(1);
  });

  it("is left exactly where it is when it is still inside the window", () => {
    const recent = [text("old"), text("pin"), text("newer")];
    expect(roomContextMessages(recent, 3, "pin").map((m) => m.id)).toEqual(["old", "pin", "newer"]);
  });

  it("changes nothing when the pin is gone, or was never a text message", () => {
    expect(roomContextMessages(long(), GROUP_CONTEXT_MESSAGES, "deleted").map((m) => m.id)).not.toContain("deleted");
    const withCard: Line[] = [{ id: "card", kind: "options" }, ...long()];
    expect(roomContextMessages(withCard, GROUP_CONTEXT_MESSAGES, "card").map((m) => m.id)).not.toContain("card");
  });

  it("keeps the recall exclusion honest: everything the prompt carries is excluded", () => {
    const messages = long();
    const carried = roomContextMessages(messages, GROUP_CONTEXT_MESSAGES, "pin").map((m) => m.id);
    expect(roomContextMessageIds(messages, GROUP_CONTEXT_MESSAGES, "pin")).toEqual(carried);
    // Without the pin the exclusion would be a message short, and the pinned
    // line would come back a second time as a remembered "source".
    expect(roomContextMessageIds(messages)).not.toContain("pin");
  });
});

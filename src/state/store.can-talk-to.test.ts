// "Can talk to": going back to My team must show. The server stores My team as nothing, so its frames omit the field.
import { describe, expect, it } from "vitest";

import { initialState, reducer, type Bot } from "./store";
import { canTalkMode } from "@/lib/can-talk-to";

const ember = { id: "ember", name: "Ember", threadId: "t1", messages: [], messageAllow: { mode: "all" } } as unknown as Bot;
const held = () => ({ ...initialState, bots: [ember] });

describe("Can talk to, Everyone back to My team", () => {
  it("a bot frame without messageAllow clears Everyone", () => {
    const next = reducer(held(), { type: "botPatched", source: "stream", bot: { id: "ember", name: "Ember", threadId: "t1" } as never });
    expect(canTalkMode(next.bots[0]!)).toBe("team");
    expect(next.bots[0]!.messageAllow).toBeUndefined();
  });
  it("a bot frame that carries the setting still sets it", () => {
    const next = reducer(held(), { type: "botPatched", source: "stream", bot: { id: "ember", name: "Ember", threadId: "t1", messageAllow: { mode: "list", botIds: ["b"] } } as never });
    expect(next.bots[0]!.messageAllow).toEqual({ mode: "list", botIds: ["b"] });
  });
  it("the save answer shows My team at once", () => {
    const next = reducer(held(), { type: "messageAllowSet", botId: "ember", messageAllow: undefined });
    expect(canTalkMode(next.bots[0]!)).toBe("team");
  });
});

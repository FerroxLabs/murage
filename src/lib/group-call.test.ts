import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { cueMemberFor, routeSpokenGroupMessage } from "./group-call";

const members = [
  { id: "atlas", name: "Atlas" },
  { id: "milind", name: "Milind" },
  { id: "research", name: "Deep Research" },
] as Bot[];

describe("routeSpokenGroupMessage", () => {
  it("turns a spoken member name into an explicit mention", () => {
    expect(routeSpokenGroupMessage("Atlas, can you take this?", members)).toEqual({
      text: "@Atlas can you take this?",
      addressed: true,
    });
    expect(routeSpokenGroupMessage("Hey Deep Research: find the source", members)).toEqual({
      text: "@Deep Research find the source",
      addressed: true,
    });
    expect(routeSpokenGroupMessage("Atlas", members)).toEqual({
      text: "@Atlas",
      addressed: true,
    });
  });

  it("turns natural room-wide addresses into @everyone", () => {
    expect(routeSpokenGroupMessage("Everyone, give me your view", members)).toEqual({
      text: "@everyone give me your view",
      addressed: true,
    });
    expect(routeSpokenGroupMessage("everyone", members)).toEqual({
      text: "@everyone",
      addressed: true,
    });
  });

  it("preserves explicit tags and ordinary speech", () => {
    expect(routeSpokenGroupMessage("@Milind please continue", members)).toEqual({
      text: "@Milind please continue",
      addressed: true,
    });
    expect(routeSpokenGroupMessage("What should we build next?", members)).toEqual({
      text: "What should we build next?",
      addressed: false,
    });
  });
});

describe("cueMemberFor", () => {
  it("prefers the member already writing", () => {
    expect(cueMemberFor("@Atlas hello", members, "milind")?.id).toBe("milind");
  });

  it("else the one member the line was addressed to", () => {
    expect(cueMemberFor("@Atlas can you take this?", members, null)?.id).toBe("atlas");
    expect(cueMemberFor("@Deep Research look this up", members, undefined)?.id).toBe("research");
  });

  it("never guesses a voice: everyone, no address, or two members means none", () => {
    expect(cueMemberFor("@everyone what do you think?", members, null)).toBeUndefined();
    expect(cueMemberFor("what do you think?", members, null)).toBeUndefined();
    expect(cueMemberFor("@Atlas and @Milind what do you think?", members, null)).toBeUndefined();
  });

  it("ignores a busy id that is not in the room", () => {
    expect(cueMemberFor("what now", members, "ghost")).toBeUndefined();
  });
});

describe("routeSpokenGroupMessage: two spoken names", () => {
  it("turns \"Atlas and Milind, ...\" into a multi-name line", () => {
    const ms = [{ id: "atlas", name: "Atlas" }, { id: "milind", name: "Milind" }] as Bot[];
    const out = routeSpokenGroupMessage("Atlas and Milind, what is left?", ms);
    expect(out).toEqual({ text: "@Atlas and @Milind what is left?", addressed: true });
    expect(cueMemberFor(out.text, ms, null)).toBeUndefined();
  });
});

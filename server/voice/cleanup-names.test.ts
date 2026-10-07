import { describe, expect, it } from "vitest";

import { namesForDoor } from "./cleanup-names.ts";

const store = {
  bots: [
    { id: "b1", name: "Ada", threadId: "tb1" },
    { id: "b2", name: "Secret Bot", threadId: "tb2" },
  ],
  groups: [
    { name: "Launch Room", threadId: "tg1" },
    { name: "Private DM", threadId: "tg2" },
  ],
  bot: (id: string) => (id === "b2" ? { hidden: true } : id === "b1" ? {} : null),
  botByThread: (t: string) => (t === "tb2" ? { hidden: true } : t === "tb1" ? {} : null),
  group: () => undefined,
  groupByThread: (t: string) => (t === "tg2" ? { dm: true } : t === "tg1" ? { dm: false } : undefined),
};

describe("the dictionary a surface may see", () => {
  it("gives the desktop every bot and room", () => {
    const names = namesForDoor("desktop", store as never);
    expect(names).toEqual(expect.arrayContaining(["Ada", "Secret Bot", "Launch Room", "Private DM"]));
  });

  it("gives a paired phone only what its sidebar shows", () => {
    const names = namesForDoor("companion", store as never);
    expect(names).toEqual(expect.arrayContaining(["Murage", "Flux", "Fuigo", "Ada", "Launch Room"]));
    expect(names).not.toContain("Secret Bot");
    expect(names).not.toContain("Private DM");
  });

  it("gives an unproven caller no workspace names at all", () => {
    expect(namesForDoor("unproven", store as never)).toEqual(["Murage", "Flux", "Fuigo"]);
  });
});

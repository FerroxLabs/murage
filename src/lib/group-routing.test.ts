import { describe, expect, it } from "vitest";

import { goalCoordinatorForComposer, roomRespondersForComposer } from "./group-routing";

describe("roomRespondersForComposer", () => {
  const members = [
    { id: "atlas", name: "Atlas" },
    { id: "milind", name: "Milind" },
  ];

  it("routes an unmentioned message to the configured lead", () => {
    expect(
      roomRespondersForComposer("hello there", members, { defaultResponder: { kind: "member", botId: "atlas" } }),
    ).toEqual([members[0]]);
  });

  it("lets explicit mentions override the configured lead", () => {
    expect(
      roomRespondersForComposer("@Milind take this", members, { defaultResponder: { kind: "member", botId: "atlas" } }),
    ).toEqual([members[1]]);
  });

  // Upstream #1607: the composer's preview uses the same boundaries as the
  // server, so a wrapped mention shows the bot that will actually answer.
  it("uses the shared Markdown, bracket and Unicode mention boundaries", () => {
    const mentionsOnly = { defaultResponder: { kind: "mentions" } } as const;
    expect(roomRespondersForComposer("**@Milind**", members, mentionsOnly)).toEqual([members[1]]);
    expect(roomRespondersForComposer("(@Milind)", members, mentionsOnly)).toEqual([members[1]]);
    expect(roomRespondersForComposer("_@Milind_", members, mentionsOnly)).toEqual([members[1]]);
    expect(roomRespondersForComposer("【@Milind】", members, mentionsOnly)).toEqual([members[1]]);
    expect(roomRespondersForComposer("user@Milind /@Milind", members, mentionsOnly)).toEqual([]);
    expect(roomRespondersForComposer("@Milind調査", members, mentionsOnly)).toEqual([]);
    expect(roomRespondersForComposer("İ @Milind", members, mentionsOnly)).toEqual([members[1]]);
    expect(roomRespondersForComposer("**@EVERYONE** hello", members, mentionsOnly)).toEqual(members);
    expect(roomRespondersForComposer("@everyone調査 hello", members, mentionsOnly)).toEqual([]);
  });

  it("supports everyone and mentions-only room policies", () => {
    expect(roomRespondersForComposer("hello", members, { defaultResponder: { kind: "everyone" } })).toEqual(members);
    expect(roomRespondersForComposer("hello", members, { defaultResponder: { kind: "mentions" } })).toEqual([]);
    expect(roomRespondersForComposer("@everyone hello", members, { defaultResponder: { kind: "mentions" } })).toEqual(
      members,
    );
  });

  it("routes a reply to a member's message to that member unless the text mentions someone", () => {
    const group = { defaultResponder: { kind: "member" as const, botId: "atlas" } };
    expect(roomRespondersForComposer("what did you mean?", members, group, "milind")).toEqual([members[1]]);
    expect(roomRespondersForComposer("@Atlas check this", members, group, "milind")).toEqual([members[0]]);
    expect(roomRespondersForComposer("@everyone check this", members, group, "milind")).toEqual(members);
    expect(roomRespondersForComposer("hello", members, group, "stranger")).toEqual([members[0]]);
  });
});

describe("goalCoordinatorForComposer", () => {
  const members = [
    { id: "first", name: "First" },
    { id: "chief", name: "Chief", chiefOfStaff: true },
    { id: "writer", name: "Writer" },
  ];

  it("uses an explicit mention before the configured lead", () => {
    expect(goalCoordinatorForComposer(
      "@Writer finish this",
      members,
      { defaultResponder: { kind: "member", botId: "first" } },
    )?.id).toBe("writer");
  });

  it("falls back to the in-room Chief for mentions-only goal channels", () => {
    expect(goalCoordinatorForComposer(
      "finish this",
      members,
      { defaultResponder: { kind: "mentions" } },
    )?.id).toBe("chief");
  });
});

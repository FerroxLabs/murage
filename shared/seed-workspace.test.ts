import { describe, expect, it } from "vitest";
import { firstRunImportAllowed } from "./seed-workspace";

const seed = { threadId: "t1", title: "", description: "", tasks: [{ threadId: "t1" }] };
const opening = [{ role: "bot", kind: "text", text: "Hello." }, { role: "bot", kind: "options", card: {} }];

describe("first-run starter import", () => {
  it("goes ahead on an empty workspace and on one holding only the untouched seeded bot", () => {
    expect(firstRunImportAllowed({ bots: [], groups: [] }, () => [])).toBe(true);
    expect(firstRunImportAllowed({ bots: [seed], groups: [] }, id => (id === "t1" ? opening : []))).toBe(true);
  });
  it("is refused once the person has used the workspace", () => {
    const said = [...opening, { role: "user", kind: "text", text: "Help me plan my week" }];
    expect(firstRunImportAllowed({ bots: [seed], groups: [] }, () => said)).toBe(false);
    expect(firstRunImportAllowed({ bots: [seed, { ...seed, threadId: "t2" }], groups: [] }, () => opening)).toBe(false);
    expect(firstRunImportAllowed({ bots: [seed], groups: [{ id: "g1" }] }, () => opening)).toBe(false);
    expect(firstRunImportAllowed({ bots: [{ ...seed, title: "Operations lead" }], groups: [] }, () => opening)).toBe(false);
    expect(firstRunImportAllowed({ bots: [seed], groups: [] }, () => [...opening, { role: "bot", kind: "activity" }])).toBe(false);
  });
});

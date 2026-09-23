import { describe, expect, it } from "vitest";
import { skillContentHash } from "./content-hash.ts";

const base = { name: "invoice-chaser", description: "Chases invoices.", triggerTerms: ["invoice"], files: [{ path: "SKILL.md", content: "Do the thing.\n" }] };

describe("skill content hash", () => {
  it("is stable across line endings, trailing spaces and file order", () => {
    const a = skillContentHash({ ...base, files: [{ path: "b.md", content: "B" }, { path: "SKILL.md", content: "Do the thing.\r\n" }] });
    const b = skillContentHash({ ...base, files: [{ path: "SKILL.md", content: "Do the thing.   \n" }, { path: "b.md", content: "B" }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
  it("changes when any file, the description or a trigger term changes", () => {
    const h = skillContentHash(base);
    expect(skillContentHash({ ...base, description: "Chases invoices!" })).not.toBe(h);
    expect(skillContentHash({ ...base, triggerTerms: ["bill"] })).not.toBe(h);
    expect(skillContentHash({ ...base, files: [{ path: "SKILL.md", content: "Do another thing." }] })).not.toBe(h);
    expect(skillContentHash({ ...base, files: [{ path: "OTHER.md", content: "Do the thing." }] })).not.toBe(h);
  });
  it("cannot be forged by moving text between fields", () => {
    expect(skillContentHash({ ...base, description: "a", files: [{ path: "SKILL.md", content: "b" }] }))
      .not.toBe(skillContentHash({ ...base, description: "a\0b", files: [{ path: "SKILL.md", content: "" }] }));
  });
});

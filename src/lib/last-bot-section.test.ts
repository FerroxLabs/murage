import { describe, expect, it } from "vitest";
import { LAST_BOT_SECTION_KEY, lastBotSection, rememberBotSection } from "./last-bot-section";

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; }, data };
};
const offered = ["overview", "skills", "memory"] as const;

describe("last bot section", () => {
  it("reopens the remembered section", () => {
    const store = memory();
    rememberBotSection("skills", () => store);
    expect(lastBotSection(offered, [], () => store)).toBe("skills");
  });
  it("ignores an id this window does not offer, such as a desktop-only section on a phone", () => {
    expect(lastBotSection(offered, [], () => memory({ [LAST_BOT_SECTION_KEY]: "shapes" }))).toBeNull();
    expect(lastBotSection(offered, [], () => memory({ [LAST_BOT_SECTION_KEY]: "constructor" }))).toBeNull();
  });
  it("skips a section that should not restore", () => {
    expect(lastBotSection(offered, ["memory"], () => memory({ [LAST_BOT_SECTION_KEY]: "memory" }))).toBeNull();
  });
  it("copes with blocked storage", () => {
    expect(lastBotSection(offered, [], () => { throw new Error("blocked"); })).toBeNull();
    expect(() => rememberBotSection("skills", () => { throw new Error("blocked"); })).not.toThrow();
  });
});

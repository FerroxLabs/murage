import { describe, expect, it } from "vitest";
import { mentionRowDescription } from "./mentions";

describe("mention row description", () => {
  it("says how many bots @everyone reaches", () => {
    expect(mentionRowDescription({ id: "__everyone__" }, 4)).toBe("Reaches 4 bots");
    expect(mentionRowDescription({ id: "__everyone__" }, 1)).toBe("Reaches 1 bot");
  });
  it("uses the bot title, then the Chief line, then the description", () => {
    expect(mentionRowDescription({ id: "a", bot: { title: "Researcher", description: "x" } }, 0)).toBe("Researcher");
    expect(mentionRowDescription({ id: "b", bot: { title: "", chiefOfStaff: true, chiefScope: "workspace" } }, 0)).toBe("Runs the workspace");
    expect(mentionRowDescription({ id: "c", bot: { title: " ", description: "\nFinds leads.\nMore." } }, 0)).toBe("Finds leads.");
  });
  it("is empty for a bot with nothing to say, and caps a long line", () => {
    expect(mentionRowDescription({ id: "d", bot: {} }, 0)).toBe("");
    expect(mentionRowDescription({ id: "e", bot: { description: "y".repeat(200) } }, 0).length).toBeLessThanOrEqual(70);
  });
});

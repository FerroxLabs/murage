import { describe, expect, it } from "vitest";
import { emergencyStopWarning } from "./emergency-stop";

describe("emergencyStopWarning", () => {
  it("says nothing when every stop was confirmed", () => {
    expect(emergencyStopWarning({ ok: true, stopped: [{ botId: "b", threadId: "t" }] })).toBeNull();
    expect(emergencyStopWarning(undefined)).toBeNull();
  });

  it("names how many tasks did not confirm their stop, in one line", () => {
    expect(emergencyStopWarning({ ok: false, stopped: [], failed: [{ botId: "b", threadId: "t" }] }))
      .toBe("1 task did not confirm it stopped. Restart Murage if a bot is still using this computer.");
    expect(emergencyStopWarning({ ok: false, stopped: [], failed: [{ botId: "b", threadId: "t" }, { botId: "b", threadId: "u" }] }))
      .toBe("2 tasks did not confirm they stopped. Restart Murage if a bot is still using this computer.");
    expect(emergencyStopWarning({ ok: false })).toMatch(/^Some tasks did not confirm they stopped\./u);
  });
});

import { describe, expect, it } from "vitest";

import { resourceWaitLabel } from "./resource-wait";
import { classifyLocalResourceConflict } from "../../shared/provider-error";

describe("resourceWaitLabel", () => {
  it("names the thread being waited for and the resource it holds", () => {
    expect(resourceWaitLabel({ resource: "computer", holderTitle: "Trustpilot sweep" }))
      .toBe("Waiting for 'Trustpilot sweep' to finish using the computer");
    expect(resourceWaitLabel({ resource: "working-folder", holderTitle: " Refactor " }))
      .toBe("Waiting for 'Refactor' to finish using the working folder");
    expect(resourceWaitLabel({ resource: "browser", holderTitle: "Research" }))
      .toBe("Waiting for 'Research' to finish using the browser profile");
  });

  it("says a queued routine is waiting for a free thread slot", () => {
    expect(resourceWaitLabel({ resource: "thread-slot" }))
      .toBe("Waiting for a free slot: this bot is already working on three threads");
  });

  it("stays generic without a visible title and for unknown kinds", () => {
    expect(resourceWaitLabel({ resource: "shared" })).toBe("Waiting for another thread to finish using the computer, browser or working folder");
    expect(resourceWaitLabel({ resource: "computer", holderTitle: "  " })).toBe("Waiting for another thread to finish using the computer");
    expect(resourceWaitLabel({ resource: "screen" as never })).toBe("Waiting for another thread to finish using the computer, browser or working folder");
  });

  it("is absent for a task that is not waiting, and is not an error card", () => {
    expect(resourceWaitLabel(undefined)).toBeUndefined();
    expect(resourceWaitLabel(null)).toBeUndefined();
    // The waiting label is a live status, never classified as the saved busy failure.
    expect(classifyLocalResourceConflict(resourceWaitLabel({ resource: "computer" }))).toBeUndefined();
  });

  // SL-L L1/L2 (1.0.4 item 127). User failure: "I can't tell where my turn is in line or that it will start by itself."
  it("shows the place in line and that the turn starts by itself", () => {
    expect(resourceWaitLabel({ resource: "working-folder", holderTitle: "Refactor", position: 2 }))
      .toBe("2nd in line for the working folder. Starts by itself when the turns ahead finish.");
    expect(resourceWaitLabel({ resource: "computer", position: 1 }))
      .toBe("1st in line for the computer. Starts by itself when the turns ahead finish.");
    expect(resourceWaitLabel({ resource: "browser", position: 3 }))
      .toBe("3rd in line for the browser profile. Starts by itself when the turns ahead finish.");
    expect(resourceWaitLabel({ resource: "shared", position: 11 }))
      .toBe("11th in line for the computer, browser or working folder. Starts by itself when the turns ahead finish.");
  });

  it("adds an estimate only when the server measured one", () => {
    expect(resourceWaitLabel({ resource: "working-folder", position: 2, estimateMs: 4 * 60_000 + 10_000 }))
      .toBe("2nd in line for the working folder. Starts by itself when the turns ahead finish. About 4 min.");
    expect(resourceWaitLabel({ resource: "working-folder", position: 1, estimateMs: 40_000 }))
      .toBe("1st in line for the working folder. Starts by itself when the turns ahead finish. About 1 min.");
    // under 30 s rounds to 0: no estimate at all
    expect(resourceWaitLabel({ resource: "working-folder", position: 1, estimateMs: 29_000 }))
      .toBe("1st in line for the working folder. Starts by itself when the turns ahead finish.");
    expect(resourceWaitLabel({ resource: "working-folder", position: 1 }))
      .not.toContain("About");
  });

  it("keeps today's text without a usable place in line", () => {
    expect(resourceWaitLabel({ resource: "working-folder", holderTitle: "Refactor", position: 0 }))
      .toBe("Waiting for 'Refactor' to finish using the working folder");
    expect(resourceWaitLabel({ resource: "thread-slot", position: 2 }))
      .toBe("Waiting for a free slot: this bot is already working on three threads");
  });
});

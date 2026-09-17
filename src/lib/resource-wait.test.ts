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
});

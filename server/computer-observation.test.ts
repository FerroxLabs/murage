import { describe, expect, it } from "vitest";
import { normalizeCrop, ObservationCoordinator, parseBrowserTargets, safeBrowserUrl } from "./computer-observation.ts";

describe("computer observation coordinator", () => {
  it("captures after actions but sends vision only for changed pixels", () => {
    const coordinator = new ObservationCoordinator();
    expect(coordinator.needsCapture()).toBe(true);
    expect(coordinator.observeFrame("frame-a", null)).toMatchObject({ changed: true });
    expect(coordinator.needsCapture()).toBe(false);
    coordinator.noteAction();
    expect(coordinator.needsCapture()).toBe(true);
    expect(coordinator.observeFrame("frame-a", null)).toMatchObject({ changed: false });
    coordinator.noteAction();
    expect(coordinator.observeFrame("frame-b", { x: 20, y: 20, width: 100, height: 100 })).toMatchObject({ changed: true });
    expect(coordinator.metrics).toMatchObject({ screenshotsCaptured: 3, screenshotsSentToModel: 2, fullScreenObservations: 1, croppedObservations: 1, computerActions: 2 });
  });

  it("accepts bounded crop regions and rejects invalid ones", () => {
    expect(normalizeCrop({ x: 10, y: 20, width: 200, height: 100 })).toEqual({ x: 10, y: 20, width: 200, height: 100 });
    expect(normalizeCrop({ x: -1, y: 0, width: 200, height: 100 })).toBeNull();
    expect(normalizeCrop({ x: 1200, y: 0, width: 200, height: 100 })).toBeNull();
  });

  it("uses safe structured Chrome targets without query-string data", () => {
    expect(safeBrowserUrl("https://example.com/a?token=secret#fragment")).toBe("https://example.com/a");
    expect(parseBrowserTargets(JSON.stringify([
      { id: "one", type: "page", title: " Example page ", url: "https://example.com/a?token=secret" },
      { id: "two", type: "service_worker", url: "https://example.com/worker" },
    ]))).toEqual([{ id: "one", title: "Example page", url: "https://example.com/a" }]);
  });
});

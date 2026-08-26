import { describe, expect, it } from "vitest";
import { vpsComputerNeedsReplacement, type VpsComputerStatus } from "./vps-computer";

const current: VpsComputerStatus = {
  configured: true,
  imageMatches: true,
  managed: true,
  container: "running",
  ready: true,
  problem: null,
};

describe("VPS computer upgrade recovery", () => {
  it("offers replacement only for an existing managed container with an incompatible image", () => {
    expect(vpsComputerNeedsReplacement({ ...current, imageMatches: false, ready: false })).toBe(true);
    expect(vpsComputerNeedsReplacement({ ...current, container: "stopped", imageMatches: false, ready: false })).toBe(true);
    expect(vpsComputerNeedsReplacement({ ...current, container: "missing", imageMatches: false, ready: false })).toBe(false);
    expect(vpsComputerNeedsReplacement({ ...current, managed: false, imageMatches: false, ready: false })).toBe(false);
    expect(vpsComputerNeedsReplacement(current)).toBe(false);
  });
});

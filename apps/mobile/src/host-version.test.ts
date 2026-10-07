import { describe, expect, it } from "vitest";
import { hostCapabilityOk, MIN_HOST_CAPABILITY } from "./host-version";

describe("hostCapabilityOk", () => {
  it("requires mobileFeatures 1", () => {
    expect(MIN_HOST_CAPABILITY).toBe(1);
  });

  it.each([
    [1, true], [2, true], [3, true], [undefined, false], [null, false],
    ["2", false], [2.5, false], [NaN, false], [0, false],
    [Infinity, false], [-Infinity, false], [true, false], [{}, false], [[], false],
  ])("checks %s as %s", (value, expected) => {
    expect(hostCapabilityOk(value)).toBe(expected);
  });
});

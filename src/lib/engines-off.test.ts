import { expect, it } from "vitest";
import { enginesOnlySwitchedOff } from "./engines-off";
const on = { enabled: true, snapshot: { state: "available" } }, off = { enabled: false, snapshot: { state: "available" } }, missing = { enabled: true, snapshot: { state: "unavailable" } };
it("a restored installation (engines present, all switched off) keeps its conversations on screen (D7)", () => {
  expect(enginesOnlySwitchedOff([off, off])).toBe(true);
  expect(enginesOnlySwitchedOff([off, missing])).toBe(true);
  expect(enginesOnlySwitchedOff([off, on])).toBe(false);
  expect(enginesOnlySwitchedOff([missing])).toBe(false);
  expect(enginesOnlySwitchedOff([])).toBe(false);
});

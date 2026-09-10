import { expect, it } from "vitest";
import { assertBrowserProfilePrecondition } from "./browser-profile-precondition.ts";

const current = [{ id: "work", name: "Work", partitionId: "Work" }];
it("accepts empty/current canonical snapshots without granting partition routing", () => {
  expect(() => assertBrowserProfilePrecondition([], [])).not.toThrow();
  expect(() => assertBrowserProfilePrecondition([{ name: "Work", id: "work" }], current)).not.toThrow();
});
it("refuses missing and stale full-list snapshots explicitly", () => {
  for (const expected of [undefined, [], [{ id: "work", name: "Old name" }]]) {
    try { assertBrowserProfilePrecondition(expected, current); throw Error("Expected conflict"); }
    catch (error) { expect(error).toMatchObject({ status: 409 }); expect((error as Error).message).toMatch(/[Rr]efresh/); }
  }
});
it.each([null, "work", {}, [{ id: "work", name: "Work", partitionId: "Other" }], [{ id: "work", name: "Work", extra: true }]])("rejects malformed or authority-bearing expected values: %j", expected => {
  try { assertBrowserProfilePrecondition(expected, current); throw Error("Expected invalid snapshot"); }
  catch (error) { expect(error).toMatchObject({ status: 400 }); }
});

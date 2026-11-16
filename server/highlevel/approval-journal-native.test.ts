import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";

const injected = vi.hoisted(() => ({ driveInfo: vi.fn(), missing: false }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), platform: () => "win32" }));
vi.mock("../engine-exclusion.ts", () => ({ requireWindowsAddon: () => {
  if (injected.missing) throw Error("Native helper missing");
  return { driveInfo: injected.driveInfo };
} }));
import { assertJournalStorage } from "./approval-journal-storage.ts";
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "journal-native-"));
  injected.missing = false;
  injected.driveInfo.mockReset();
});
afterEach(() => removeTempDirSync(directory));
it.each(["Fixed", "Removable"])("accepts native local %s NTFS evidence for the resolved directory", type => {
  injected.driveInfo.mockReturnValue({ format: "NTFS", type });
  expect(() => assertJournalStorage(directory)).not.toThrow();
  expect(injected.driveInfo).toHaveBeenCalledExactlyOnceWith(realpathSync(directory));
});
it.each([null, undefined, {}, { format: "NTFS", type: "Network" }, { format: "NTFS", type: "Unknown" }, { format: "NTFS", type: "Ram" }, { format: "exFAT", type: "Fixed" }])("refuses unknown or unsupported native volume evidence: %j", evidence => {
  injected.driveInfo.mockReturnValue(evidence);
  expect(() => assertJournalStorage(directory)).toThrow(/HighLevel approval journal.*local NTFS.*network/);
});
it("fails closed with actionable guidance when the helper is missing or its query fails", () => {
  injected.missing = true;
  expect(() => assertJournalStorage(directory)).toThrow(/HighLevel approval journal.*local NTFS/);
  injected.missing = false;
  injected.driveInfo.mockImplementation(() => { throw Error("query failed"); });
  expect(() => assertJournalStorage(directory)).toThrow(/HighLevel approval journal.*disk health/);
});

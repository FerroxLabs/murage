// The revocation diagnostic goes to stderr: helpers that print JSON on stdout must stay parseable.
import { expect, it, vi } from "vitest";
import { noteRevocation } from "./revocation.ts";

it("noteRevocation writes the diagnostic via console.warn and never console.info or console.log", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(noteRevocation("records", "tombstones", 3)).toBe(3);
  const stdoutCalls = info.mock.calls.length + log.mock.calls.length;
  const warned = warn.mock.calls.flat();
  info.mockRestore(); log.mockRestore(); warn.mockRestore();
  expect(stdoutCalls).toBe(0);
  expect(warned).toContain("memory receipts revoked scope=records cause=tombstones count=3");
});

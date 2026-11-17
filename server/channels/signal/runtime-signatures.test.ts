import { afterEach, beforeEach, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({ authenticode: vi.fn(), missing: false }));
vi.mock("../../engine-exclusion.ts", () => ({ requireWindowsAddon: () => {
  if (injected.missing) throw Error("Murage's Windows helper is missing. Reinstall Murage to repair it.");
  return { authenticode: injected.authenticode };
} }));
// @ts-expect-error Shared ESM staging/runtime verifier has no declaration file.
import { probeSignatures } from "./runtime-integrity.mjs";
const request = { paths: ["C:\\fixture\\java.exe", "C:\\fixture\\library.dll"], identity: { subject: "CN=Fixture, O=Fixture" }, target: "win32-x64" };
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  injected.missing = false;
  injected.authenticode.mockReset().mockResolvedValue({ status: "Valid", subject: request.identity.subject });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it("awaits native trust for every path and accepts only the exact verified leaf subject", async () => {
  expect(await probeSignatures(request)).toBe(true);
  expect(injected.authenticode.mock.calls).toEqual(request.paths.map(path => [path]));
  for (const answer of [null, {}, { status: "NotTrusted", subject: request.identity.subject }, { status: "Valid", subject: "CN=Fixture" }, { status: "Valid", publisher: request.identity.subject }]) {
    injected.authenticode.mockReset().mockResolvedValueOnce({ status: "Valid", subject: request.identity.subject }).mockResolvedValueOnce(answer);
    expect(await probeSignatures(request)).toBe(false);
    expect(injected.authenticode).toHaveBeenCalledTimes(2);
  }
});
it("refuses helper errors and gives repair guidance when the helper is missing", async () => {
  injected.authenticode.mockRejectedValue(Error("native failure"));
  expect(await probeSignatures(request)).toBe(false);
  injected.missing = true;
  await expect(probeSignatures(request)).rejects.toThrow(/Windows helper.*Reinstall/);
});
it("bounds an unfinished native check to the original 1500 ms deadline", async () => {
  vi.useFakeTimers();
  injected.authenticode.mockImplementation(() => new Promise(() => {}));
  const checked = probeSignatures(request);
  await vi.advanceTimersByTimeAsync(1500);
  expect(await checked).toBe(false);
});

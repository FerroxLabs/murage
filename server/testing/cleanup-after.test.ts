import { expect, it } from "vitest";
import { cleanupAfter } from "./cleanup-after.ts";

const ok = async () => ({ status: 200, body: { ok: true } });

it("cleanup after a passing body returns the body's value and runs cleanup once", async () => {
  let runs = 0;
  expect(await cleanupAfter(async () => "value", async () => { runs++; return ok(); })).toBe("value");
  expect(runs).toBe(1);
});

it("a passing body does not hide a cleanup request that answers a failure status", async () => {
  await expect(cleanupAfter(async () => "value", async () => ({ status: 409, body: { error: "busy elsewhere" } }), "interrupt"))
    .rejects.toThrow(/interrupt answered HTTP 409: .*busy elsewhere/);
});

it("a passing body does not hide a cleanup request that throws", async () => {
  await expect(cleanupAfter(async () => "value", async () => { throw new Error("socket closed"); }, "interrupt"))
    .rejects.toThrow(/interrupt threw: .*socket closed/);
});

it("a failing body keeps its own error and gains the cleanup diagnostic", async () => {
  const original = new Error("expected card to be answered");
  for (const cleanup of [
    async () => ({ status: 500, body: { error: "stop failed" } }),
    async (): Promise<{ status: number }> => { throw new Error("stop failed"); },
  ]) {
    const seen = await cleanupAfter(async () => { throw original; }, cleanup, "interrupt").catch(error => error);
    expect(seen).toBe(original);
    expect(seen.message).toMatch(/^expected card to be answered/);
    expect(seen.message).toMatch(/interrupt (answered HTTP 500|threw): .*stop failed/);
  }
});

it("a failing body with a clean cleanup rethrows the original error unchanged", async () => {
  const original = new Error("expected card to be answered");
  let runs = 0;
  const seen = await cleanupAfter(async () => { throw original; }, async () => { runs++; return ok(); }).catch(error => error);
  expect(seen).toBe(original);
  expect(seen.message).toBe("expected card to be answered");
  expect(runs).toBe(1);
});

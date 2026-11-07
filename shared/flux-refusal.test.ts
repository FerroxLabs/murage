import { expect, it } from "vitest";
import { classifyFluxRefusal } from "./flux-refusal.ts";
for (const code of ["key_budget_reached", "budget_exceeded", "credit_exhausted", "monthly_cap"]) {
  for (const body of [{ error: { code } }, { error: code }, code]) it(`classifies ${JSON.stringify(body)} before information loss`, () => {
    expect(classifyFluxRefusal(402, body)).toBe("budget");
    expect(classifyFluxRefusal(200, body)).toBe("budget");
    expect(classifyFluxRefusal(4402, body)).toBe("budget");
  });
}
it("keeps premium distinct and ignores ordinary output", () => {
  for (const body of [{ error: { code: "premium_locked" } }, { error: "premium_locked" }, "premium_locked"]) expect(classifyFluxRefusal(402, body)).toBe("premium");
  expect(classifyFluxRefusal(200, { choices: [{ delta: { content: "budget exceeded" } }] })).toBe("other");
  expect(classifyFluxRefusal(200, "check billing and budget")).toBe("other");
});

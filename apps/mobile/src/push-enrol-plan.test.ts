import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decide } from "./push-enrol-plan";

const cases: Array<Record<string, any>> = JSON.parse(readFileSync(new URL("../contract/push-enrol.json", import.meta.url), "utf8"));
describe("registerPush plan", () => {
  it.each(cases)("$permission, binding $binding, detail $hasDetail, fresh $fresh → $plan", (c) => {
    expect(decide(c.permission, c.binding, c.hasDetail, c.fresh)).toBe(c.plan);
  });
});

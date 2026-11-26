// The Health dot reflects failing routines. 1.0.20 owner walk: the Routines page read a red 178 (failed and missed
// runs not yet opened) while the You menu's Health dot was green.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unseenRoutineProblems } from "@/components/routines/RoutineProblemsList";
import { healthFromEngines, healthWithChecks, healthWithRoutines } from "./health-status";

const ok = healthFromEngines({ id: "e", label: "Engine", state: "ready" } as never, "none", true);
const run = (status: string, seenAt: number | null = null) => ({ id: `${status}-${seenAt}`, status, seenAt, scheduledFor: 1 }) as never;

describe("Health reflects failing routines", () => {
  it("green only while no failed or missed run is unopened", () => {
    expect(ok.level).toBe("ok");
    expect(healthWithRoutines(ok, [])).toBe(ok);
    expect(healthWithRoutines(ok, [run("completed")])).toBe(ok);
    // opened failures are the owner's already
    expect(healthWithRoutines(ok, [run("failed", 5)])).toBe(ok);
  });
  it("an unopened failed or missed run turns an all-clear amber, never red", () => {
    const runs = [run("completed"), run("failed")];
    expect(unseenRoutineProblems(runs)).toHaveLength(1); // the Routines page's red count
    expect(healthWithRoutines(ok, runs)).toMatchObject({ level: "watch", line: "Worth a look, nothing is urgent." });
    expect(healthWithRoutines(ok, [run("missed")]).level).toBe("watch");
    expect(healthWithRoutines(healthWithChecks(ok, null), runs).level).not.toBe("act");
  });
  it("a louder level keeps its own words", () => {
    const act = { level: "act" as const, line: "Engine signed out." };
    expect(healthWithRoutines(act, [run("failed")])).toBe(act);
  });
  it("the You menu dot and the Health page both read it", () => {
    const hook = readFileSync(fileURLToPath(new URL("./health-status.ts", import.meta.url)), "utf8");
    expect(hook).toMatch(/return healthWithRoutines\(healthWithChecks\(engines, checks\), state\.routineRuns\);/);
    const page = readFileSync(fileURLToPath(new URL("./HealthPageBody.tsx", import.meta.url)), "utf8");
    expect(page).toMatch(/const status = healthWithRoutines\(healthWithChecks\([^\n]*\), state\.routineRuns\);/);
  });
});

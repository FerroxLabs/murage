import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { linkNoLimitsState } from "./no-limits-state.ts";

it("N5 joining native session stores preserves colliding and distinct existing context", () => {
  const root = mkdtempSync(join(tmpdir(), "native-state-join-"));
  try {
    const lower = join(root, "lower"), upper = join(root, "upper");
    for (const home of [lower, upper]) mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(lower, "sessions", "same.json"), "CURRENT-LOWER");
    writeFileSync(join(upper, "sessions", "same.json"), "PREVIOUS-NO-LIMITS");
    writeFileSync(join(upper, "sessions", "distinct.json"), "DISTINCT-CONTEXT");
    linkNoLimitsState(upper, lower, ["sessions"]);
    expect(readFileSync(join(upper, "sessions", "same.json"), "utf8")).toBe("CURRENT-LOWER");
    expect(readFileSync(join(upper, "sessions", "distinct.json"), "utf8")).toBe("DISTINCT-CONTEXT");
    const saved = readdirSync(upper).find(name => name.startsWith("sessions.before-state-share-"));
    expect(readFileSync(join(upper, saved!, "same.json"), "utf8")).toBe("PREVIOUS-NO-LIMITS");
    linkNoLimitsState(upper, lower, ["sessions"]);
    expect(readdirSync(upper).filter(name => name.startsWith("sessions.before-state-share-"))).toHaveLength(1);
  } finally { removeTempDirSync(root); }
});

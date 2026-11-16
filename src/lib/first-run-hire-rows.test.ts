import { describe, expect, it } from "vitest";

import { listStarterProfiles } from "../../server/starter-profiles.ts";
import { HIRE_ROWS } from "@/components/FirstRunHireCard";
import { FIRST_RUN_COPY } from "./first-run-copy";

describe("1.11 hire rows follow the starter catalog", () => {
  it("every row names an agent the starter packages carry, under the same name", () => {
    const profiles = listStarterProfiles() as Array<{ id: string; agents: Array<{ key: string; name: string }> }>;
    for (const row of HIRE_ROWS) {
      const agent = profiles.find((profile) => profile.id === row.profileId)?.agents.find((entry) => entry.key === row.key);
      expect(agent, row.key).toBeTruthy();
      expect(agent!.name).toBe(FIRST_RUN_COPY.hire.rows[row.key].name);
    }
  });
});

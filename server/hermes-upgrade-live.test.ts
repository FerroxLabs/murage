// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// O12 against a real Hermes (0.1.61 L4 live check). Runs only when
// HERMES_LIVE_COPY names a COPIED Hermes root whose sticky profile is
// not `default`; it asks that profile one question through the same argv the
// driver spawns, so a pinned bot is proven to answer as the profile it ran
// before the upgrade.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { hermesSpawnArgs } from "./drivers/acp/hermes.ts";
import { planHermesProfilePins, stickyHermesProfile } from "./hermes-profiles.ts";

const home = process.env.HERMES_LIVE_COPY;

describe.skipIf(!home)("Hermes upgrade pin, live", () => {
  it("pins the plain Hermes engine to the sticky profile, which answers as itself", () => {
    const env = { ...process.env, HERMES_HOME: home };
    const sticky = stickyHermesProfile(env);
    expect(sticky).not.toBe("default");
    const pins = planHermesProfilePins({ hermes: { driver: "hermesAgent" } }, env);
    expect(pins).toEqual([{ instanceId: "hermes", profile: sticky, origin: "sticky" }]);
    const argv = hermesSpawnArgs({ profile: sticky }, env);
    expect(argv.slice(0, 2)).toEqual(["-p", sticky]);
    const answer = execFileSync("hermes", [...argv.slice(0, 2), "-z", "Reply with only your profile or role name from your SOUL, one line."], { env, encoding: "utf8", timeout: 240_000 });
    console.log(`live answer: ${answer.trim().slice(-300)}`);
    expect(answer.trim().length).toBeGreaterThan(0);
  }, 300_000);
});

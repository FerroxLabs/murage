// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.8 owner zone: an engine is handed the owner's zone as TZ (engine-env.ts withOwnerTimeZone). The owner map is
// captured once per session, before the owner chose or changed a zone, so the capture alone hands the old zone.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PinRun } from "../shared/arg-vocabulary.ts";
import { handedEngineEnv, withOwnerTimeZone } from "./engine-env.ts";
import { applyOwnerTimeZone } from "./owner-time-zone.ts";

vi.mock("./env-path.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./env-path.ts")>();
  // the session's capture, taken while the computer's zone was Bangkok
  return { ...actual, captureOwnerEnv: async () => ({ env: { HOME: "/home/owner", PATH: "/usr/bin:/bin", TZ: "Asia/Bangkok" }, capture: "session" as const, generation: 0 }) };
});

const noRun: PinRun = async () => ({ ok: false, stdout: "", stderr: "" });

describe("the zone an engine is handed", () => {
  afterEach(() => { applyOwnerTimeZone(""); });

  it("is the owner's zone now, not the one in the session's capture", async () => {
    applyOwnerTimeZone("America/Chicago");
    expect((await handedEngineEnv({ platform: "linux", run: noRun })).env.TZ).toBe("America/Chicago");
    // a change later in the same session reaches the next engine too
    applyOwnerTimeZone("Europe/London");
    expect((await handedEngineEnv({ platform: "linux", run: noRun })).env.TZ).toBe("Europe/London");
  });

  it("changes the handed map, so the process reuse checks (which digest it) start a fresh engine", async () => {
    applyOwnerTimeZone("America/Chicago");
    const before = (await handedEngineEnv({ platform: "linux", run: noRun })).env;
    applyOwnerTimeZone("Asia/Tokyo");
    const after = (await handedEngineEnv({ platform: "linux", run: noRun })).env;
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });

  it("lets a driver that sets TZ itself keep its own, and leaves Windows to its live read", () => {
    applyOwnerTimeZone("America/Chicago");
    expect(withOwnerTimeZone({ platform: "linux", extra: { TZ: "UTC" } }).extra).toEqual({ TZ: "UTC" });
    expect(withOwnerTimeZone({ platform: "darwin" }).extra).toEqual({ TZ: "America/Chicago" });
    expect(withOwnerTimeZone({ platform: "win32" }).extra).toBeUndefined();
  });
});

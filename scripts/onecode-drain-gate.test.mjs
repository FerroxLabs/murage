// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform === "win32")("onecode drain gate (r7 test 37)", () => {
  it("computes the drain boundary and refuses unsafe enable inputs", () => {
    const test = fileURLToPath(new URL("../cloudflare/control-plane/supabase/drain-gate-test.sh", import.meta.url));
    const result = spawnSync("sh", [test], { encoding: "utf8", timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("ONECODE-DRAIN-GATE: passed 14 failed 0");
  });
});

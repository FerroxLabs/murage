// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 (S10): past the 128 KiB gate on an owner No limits turn the verdict skips the pin-override read and the glob
// re-read of the whole text (the wipe list, deny rows and key guard still read it). Below the gate, and at every other
// level, both reads run as before. The verdict is the same either way, so these rows count the reads themselves.
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ pin: 0, globLongest: 0 }));
vi.mock("../shared/prompt-capable.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../shared/prompt-capable.ts")>();
  return { ...real, pinOverrideIn: (...args: Parameters<typeof real.pinOverrideIn>) => { seen.pin += 1; return real.pinOverrideIn(...args); } };
});
vi.mock("../shared/sensitive-globs.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../shared/sensitive-globs.ts")>();
  return {
    ...real,
    globKeyRead: (...args: Parameters<typeof real.globKeyRead>) => {
      const text = args[0];
      if (typeof text === "string") seen.globLongest = Math.max(seen.globLongest, text.length);
      return real.globKeyRead(...args);
    },
  };
});

// server/testing/setup.ts already loaded auto-approve.ts's imports (via message-db.ts), so load them again under the mocks
vi.resetModules();
const { autoVerdict, COMMAND_GATE_CHARS } = await import("./auto-approve.ts");
const { approvalSummary } = await import("../shared/approval-summary.ts");

const script = (chars: number) => {
  const out: string[] = [];
  let n = 0;
  for (let k = 0; ; k++) {
    const line = `echo "step ${k}" && mkdir -p build/${k % 9}`;
    if (n + line.length + 1 > chars) break;
    out.push(line);
    n += line.length + 1;
  }
  return out.join("\n");
};
const NO_LIMITS = { id: "nl", autoApprove: true, fullAccess: true, noLimits: true };
const OWNER = { fullAccessOrigin: "owner", ownerStarted: true, stopLine: null, outsideRead: null } as const;
const verdict = (command: string) =>
  autoVerdict(NO_LIMITS as never, "shell", approvalSummary(command), { ...OWNER, exactCommand: { command } } as never);

describe("past the gate on an owner No limits turn the pin and glob re-reads are skipped", () => {
  beforeEach(() => {
    seen.pin = 0;
    seen.globLongest = 0;
  });

  it("below the gate both reads run on the whole text", () => {
    const below = script(COMMAND_GATE_CHARS - 4096);
    expect(verdict(below).approve).not.toBeNull();
    expect(seen.pin).toBeGreaterThan(0);
    expect(seen.globLongest).toBeGreaterThan(COMMAND_GATE_CHARS - 8192);
  });

  it("past the gate the pin-override read does not run, and the command still runs", () => {
    const past = script(COMMAND_GATE_CHARS + 2048);
    expect(verdict(past).approve).not.toBeNull();
    expect(seen.pin).toBe(0);
  });

  it("past the gate the glob re-read of the whole text does not run", () => {
    const past = script(COMMAND_GATE_CHARS + 2048);
    expect(verdict(past).approve).not.toBeNull();
    expect(seen.globLongest).toBeLessThan(COMMAND_GATE_CHARS);
  });
});

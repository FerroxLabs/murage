// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Section (d) of APP-GRANT-FIXPLAN-r6 (Rules 74a, 74d): one environment generation, bumped only by
// invalidateEnvCapture, fences both the owner capture and the per-ask consistency check. A capture or a check
// that started before an invalidation never publishes or reports its result.
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execChecks, gate, resetExecChecks } from "./testing/exec-check-spy.ts";
import { execEnvHanded, execEnvNow, type HandedEnv } from "./engine-env.ts";
import { isExecEnv } from "../shared/mount-identity.ts";
import { captureOwnerEnv, envGeneration, invalidateEnvCapture, ownerEnvState, resetPathCacheForTests } from "./env-path.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

vi.mock("node:child_process", async (original) => (await import("./testing/exec-check-spy.ts")).withExecCheckSpy(await original()));

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "env-fence-")));
  resetPathCacheForTests();
  invalidateEnvCapture("test start");
  resetExecChecks();
});
afterEach(() => {
  resetExecChecks();
  removeTempDirSync(dir);
});

// The stand-in shell is a #!/bin/sh script and the check rows exec /bin/sh for real; Windows runs
// neither, so those rows run on POSIX. The Windows check path has its own row in env-check-again.test.ts.
const posixShell = process.platform !== "win32";

/** A stand-in account shell: each run numbers itself (RUN=n), and while `gateFile` is absent it waits. */
function countingShell(): { shell: string; runs: () => number; release: () => void } {
  const counter = join(dir, "runs");
  const gateFile = join(dir, "gate");
  const shell = join(dir, "fake-shell");
  writeFileSync(counter, "");
  writeFileSync(shell, [
    "#!/bin/sh",
    `echo x >> "${counter}"`,
    `n=$(wc -l < "${counter}" | tr -d ' ')`,
    `while [ ! -f "${gateFile}" ]; do sleep 0.02; done`,
    `export RUN=$n PATH=/usr/bin:/bin HOME="${dir}"`,
    'shift 3; exec /bin/sh -c "$1"',
    "",
  ].join("\n"));
  chmodSync(shell, 0o755);
  return {
    shell,
    runs: () => readFileSync(counter, "utf8").split("\n").filter(Boolean).length,
    release: () => { if (!existsSync(gateFile)) writeFileSync(gateFile, ""); },
  };
}

const waitFor = async (ok: () => boolean) => {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ok()).toBe(true);
};

describe("the capture fence (Rule 74a)", () => {
  it.skipIf(!posixShell)("a capture pending across an invalidation never publishes; its caller gets a new capture", async () => {
    const fake = countingShell();
    const first = captureOwnerEnv({ shell: fake.shell });
    await waitFor(() => fake.runs() === 1);
    invalidateEnvCapture("an approved write to ~/.zlogin");
    fake.release();
    const owner = await first;
    expect(fake.runs()).toBe(2);
    expect(owner.env.RUN).toBe("2");
    expect(ownerEnvState()?.env.RUN).toBe("2");
    expect(ownerEnvState()?.capture).toBe("session");
  });

  it.skipIf(!posixShell)("a caller after the invalidation does not join the pending old capture", async () => {
    const fake = countingShell();
    const first = captureOwnerEnv({ shell: fake.shell });
    await waitFor(() => fake.runs() === 1);
    invalidateEnvCapture("an approved write to ~/.zlogin");
    const second = captureOwnerEnv({ shell: fake.shell });
    await waitFor(() => fake.runs() === 2);
    fake.release();
    expect((await second).env.RUN).toBe("2");
    expect((await first).env.RUN).not.toBe("1");
    expect(ownerEnvState()?.env.RUN).toBe("2");
  });

  it.skipIf(!posixShell)("the next spawn after an invalidation captures again, and only once", async () => {
    const fake = countingShell();
    fake.release();
    expect((await captureOwnerEnv({ shell: fake.shell })).env.RUN).toBe("1");
    expect((await captureOwnerEnv({ shell: fake.shell })).env.RUN).toBe("1");
    const before = envGeneration();
    invalidateEnvCapture("the owner asked to check again");
    expect(envGeneration()).toBe(before + 1);
    // r3 (f): the invalidation does not mark the capture kept; only a failed capture writes kept
    expect(ownerEnvState()?.capture).not.toBe("kept");
    expect((await captureOwnerEnv({ shell: fake.shell })).env.RUN).toBe("2");
    expect((await captureOwnerEnv({ shell: fake.shell })).env.RUN).toBe("2");
    expect(fake.runs()).toBe(2);
  });
});

describe("the check fence (Rule 74d)", () => {
  const handed = (): HandedEnv => ({ env: { PATH: "/usr/bin:/bin", HOME: dir, PAGER: "cat" }, absent: ["POSIXLY_CORRECT"], capture: "session", ownerStartup: {}, pins: new Map() });
  const shell = ["/bin/sh", "-c"] as const;

  it.skipIf(!posixShell)("checks once per generation, and again after an invalidation", async () => {
    const map = handed();
    expect(await execEnvNow("s1", shell, map, dir)).toMatchObject({ env: map.env, absent: ["POSIXLY_CORRECT"], cwd: dir });
    await execEnvNow("s1", shell, map, dir);
    expect(execChecks.runs).toBe(1);
    invalidateEnvCapture("an approved write to ~/.zlogin");
    expect(await execEnvNow("s1", shell, map, dir)).toMatchObject({ env: map.env });
    expect(execChecks.runs).toBe(2);
  });

  it.skipIf(!posixShell)("a check awaiting across an invalidation is not reported: it runs again", async () => {
    const map = handed();
    const held = gate();
    execChecks.hold = held.promise;
    const now = execEnvNow("s2", shell, map, dir);
    await waitFor(() => execChecks.runs === 1);
    invalidateEnvCapture("an approved write to ~/.zlogin");
    execChecks.hold = null;
    held.open();
    expect(await now).toMatchObject({ env: map.env, cwd: dir });
    expect(execChecks.runs).toBe(2);
  });

  it.skipIf(!posixShell)("an environment that keeps changing holds U20 after three re-runs", async () => {
    const map = handed();
    execChecks.onRun = () => invalidateEnvCapture("changed again");
    const result = await execEnvNow("s3", shell, map, dir);
    expect(execChecks.runs).toBe(4);
    expect(result).toMatchObject({ env: {}, absent: [], cwd: dir, shell: [...shell], capture: "session",
      unread: { code: "U20", cause: "the environment changed while it was being checked" } });
    expect(result.unchecked).toBeUndefined();
    expect(isExecEnv(result)).toBe(true);
  });

  it("the non-command form reports the handed map with no check", () => {
    const map = handed();
    expect(execEnvHanded(map, dir, shell)).toEqual({ env: map.env, absent: map.absent, cwd: dir, shell, capture: "session" });
    expect(execChecks.runs).toBe(0);
  });
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Section (f) of APP-GRANT-FIXPLAN-r3 (R2-6, Rule 74a): the Engines panel's "Check again" (GET /api/instances?fresh=1)
// invalidates the capture, awaits a new capture, awaits discovery, and only THEN reads the capture state. "kept" is
// written only by a capture that failed, never by the invalidation itself.
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureOwnerEnv, invalidateEnvCapture, ownerEnvAfterDiscovery, ownerEnvState, resetPathCacheForTests, setOwnerEnvStore } from "./env-path.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "env-check-again-")));
  resetPathCacheForTests();
  invalidateEnvCapture("test start");
  setOwnerEnvStore(join(dir, "env"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in account shell that leaves a mark each time it runs a capture. */
function markingShell(): { shell: string; mark: string } {
  const shell = join(dir, "fake-shell");
  const mark = join(dir, "captured");
  writeFileSync(shell, `#!/bin/sh\necho x >> "${mark}"\nexport PATH=/usr/bin:/bin HOME="${dir}"\nshift 3\nexec /bin/sh -c "$1"\n`);
  chmodSync(shell, 0o755);
  return { shell, mark };
}

// The account-shell capture is POSIX only: on Windows Murage never runs a login shell (the launch environment already
// carries the registry environment), so the #!/bin/sh stand-in cannot run there. Windows has its own row below.
const posixShell = process.platform !== "win32";

describe("Engines status after discovery (r3 (f))", () => {
  it.runIf(!posixShell)("on Windows, Check again reports the live session environment, never kept or fallback", async () => {
    const answer = await ownerEnvAfterDiscovery(true, async () => ["claude"]);
    expect(answer.discovered).toEqual(["claude"]);
    expect(answer.owner?.capture).toBe("session");
    expect(answer.owner?.cause).toBeUndefined();
    expect(answer.owner?.env.PATH).toBeTruthy();
    expect(existsSync(join(dir, "env"))).toBe(false);
  });

  it.skipIf(!posixShell)("the invalidation alone never marks the capture kept", async () => {
    const { shell } = markingShell();
    expect((await captureOwnerEnv({ shell })).capture).toBe("session");
    invalidateEnvCapture("the owner asked to check again");
    expect(ownerEnvState()?.capture).not.toBe("kept");
  });

  it.skipIf(!posixShell)("fresh=1 with a capture that succeeds reports session, captured before discovery runs", async () => {
    const { shell, mark } = markingShell();
    expect((await captureOwnerEnv({ shell })).capture).toBe("session");
    let runsSeenByDiscovery = -1;
    const answer = await ownerEnvAfterDiscovery(true, async () => {
      runsSeenByDiscovery = readFileSync(mark, "utf8").split("\n").filter(Boolean).length;
      return ["claude"];
    }, { shell });
    // the new capture ran (second mark) before discovery was asked
    expect(runsSeenByDiscovery).toBe(2);
    expect(answer.discovered).toEqual(["claude"]);
    expect(answer.owner?.capture).toBe("session");
    expect(answer.owner?.cause).toBeUndefined();
  });

  it.skipIf(!posixShell)("fresh=1 with a capture that fails reports kept with the time of the kept map and the cause", async () => {
    const { shell } = markingShell();
    expect((await captureOwnerEnv({ shell })).capture).toBe("session");
    writeFileSync(shell, "#!/bin/sh\nexit 3\n");
    const answer = await ownerEnvAfterDiscovery(true, async () => [], { shell });
    expect(answer.owner?.capture).toBe("kept");
    expect(typeof answer.owner?.capturedAt).toBe("number");
    expect(answer.owner?.cause).toBeTruthy();
  });

  it.skipIf(!posixShell)("fresh=1 with no validated map reports fallback with the cause", async () => {
    const shell = join(dir, "broken-shell");
    writeFileSync(shell, "#!/bin/sh\necho PATH=/x\n");
    chmodSync(shell, 0o755);
    const answer = await ownerEnvAfterDiscovery(true, async () => [], { shell });
    expect(answer.owner?.capture).toBe("fallback");
    expect(answer.owner?.cause).toBeTruthy();
    expect(existsSync(join(dir, "env"))).toBe(false);
  });

  it("the instances route reads the state through ownerEnvAfterDiscovery, not before discovery", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    const start = source.indexOf('path === "/api/instances"');
    const route = source.slice(start, source.indexOf("\n    }\n", start));
    expect(route).toContain("ownerEnvAfterDiscovery(fresh");
    expect(route).not.toContain("ownerEnvState()");
    expect(route).not.toContain("invalidateEnvCapture(");
  });
});

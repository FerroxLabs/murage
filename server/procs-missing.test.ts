import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineExecutableDeps, engineExecutableMissing, hostPowerRefused, resolveEngineExecutable, spawnCli } from "./procs.ts";
import { hostPowerDeps, HOST_POWER_TEST_UNWRAPPED } from "./host-power.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
const realDeps = { ...hostPowerDeps };
const root = () => { const dir = mkdtempSync(join(tmpdir(), "engine-presence-")); dirs.push(dir); return dir; };
afterEach(() => {
  Object.assign(hostPowerDeps, realDeps);
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = true;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});
const collect = (child: ReturnType<typeof spawnCli>) => new Promise<{ code: number | null; errors: NodeJS.ErrnoException[]; out: string }>(done => {
  const errors: NodeJS.ErrnoException[] = []; let out = "";
  child.on("error", error => errors.push(error)); child.stdout.on("data", chunk => { out += chunk; }); child.stderr.resume();
  child.once("close", code => done({ code, errors, out })); child.stdin.end();
});

describe("all wrapped engines resolve before the wrapper", () => {
  it.each(["muse", "cline", "other-engine"])("%s absent: zero wrapper spawns, cached filesystem lookup, quiet ENOENT", async name => {
    const dir = root(); const marker = join(dir, "wrapper-ran"); const wrapper = join(dir, "sandbox");
    writeFileSync(wrapper, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`); chmodSync(wrapper, 0o755);
    Object.assign(hostPowerDeps, { platform: () => "darwin", sandboxExec: wrapper });
    (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
    const checks = vi.spyOn(engineExecutableDeps, "executable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let n = 0; n < 4; n++) {
      const child = spawnCli(name, [], { cwd: dir, env: { PATH: dir }, stdio: "pipe" }, { hostPower: true });
      expect(child.pid).toBeUndefined();
      expect((await collect(child)).errors[0]?.code).toBe("ENOENT");
      expect(engineExecutableMissing(child)).toBe(true);
      expect(hostPowerRefused(child)).toBe(false);
    }
    expect(checks).toHaveBeenCalledTimes(1);
    expect(existsSync(marker)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("pins the executable from the child's PATH, with config arguments preserved, before wrapping", async () => {
    const dir = root(); const cli = join(dir, "fixture-engine"); const wrapper = join(dir, "sandbox");
    writeFileSync(cli, "#!/bin/sh\nexit 0\n"); chmodSync(cli, 0o755);
    writeFileSync(wrapper, '#!/bin/sh\nprintf "%s\\n" "$3" "$4" "$5"\n'); chmodSync(wrapper, 0o755);
    Object.assign(hostPowerDeps, { platform: () => "darwin", sandboxExec: wrapper });
    (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
    const child = spawnCli("fixture-engine fixed", ["--version"], { cwd: dir, env: { PATH: dir }, stdio: "pipe" }, { hostPower: true });
    expect((await collect(child)).out).toBe(`${cli}\nfixed\n--version\n`);
  });

  it("manual refresh invalidates missing results from every route's working folder", () => {
    const dir = root(); const cwd = join(dir, "session"); mkdirSync(cwd);
    const cli = join(dir, "engine"); const env = { PATH: dir };
    expect(resolveEngineExecutable(cli, env, dir)).toBeNull();
    expect(resolveEngineExecutable(cli, env, cwd)).toBeNull();
    writeFileSync(cli, "#!/bin/sh\nexit 0\n"); chmodSync(cli, 0o755);
    expect(resolveEngineExecutable(cli, env, dir, true)?.command).toBe(cli);
    expect(resolveEngineExecutable(cli, env, cwd)?.command).toBe(cli);
  });

  it("non-executable files and directories are absent; explicit refresh or ten minutes finds installation", () => {
    const dir = root(); const cli = join(dir, "engine"); const env = { PATH: dir };
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    writeFileSync(cli, "#!/bin/sh\nexit 0\n"); chmodSync(cli, 0o644);
    expect(resolveEngineExecutable("engine", env, dir)).toBeNull();
    expect(resolveEngineExecutable(dir, env, dir)).toBeNull();
    chmodSync(cli, 0o755);
    expect(resolveEngineExecutable("engine", env, dir)).toBeNull();
    now += 600_000;
    expect(resolveEngineExecutable("engine", env, dir)?.command).toBe(cli);
    expect(resolveEngineExecutable("engine", env, dir, true)?.command).toBe(cli);
  });
});

// What `pnpm dev:server` hands the harness.
//
// `devHarnessEnvironment` existed with no caller: the decision about the dev
// static tree was written down, tested, and never asked. The harness
// therefore served no static files in development, and the browser door — a
// phone proxied to the harness — had nothing to be handed. These tests are
// about the wiring, not the decision: that the launcher actually asks, that
// it asks about the repository rather than whatever directory it was invoked
// from, and that it does not overrule a person who set the variable by hand.
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { devHarnessEnvironment } from "../electron/harness-resources.mjs";
import { REPO_ROOT, SERVER_ENTRY, devServerEnvironment, startDevServer } from "./dev-server.mjs";
import { CAGE_APPARMOR_HELP, CAGE_BUILD_HELP, CAGE_SMOKE_ARGS, prepareSourceCage } from "./prepare-source-cage.mjs";

const built = () => true;
const unbuilt = () => false;

describe("source launch cage preparation", () => {
  const base = { platform: "linux", arch: "x64", repoRoot: REPO_ROOT };
  const failure = `Murage cage preparation could not finish: ${CAGE_BUILD_HELP}.`;

  it("builds a missing cage before spawning the dev/start server", () => {
    let ready = false;
    const exec = vi.fn((command, args) => {
      if (command === "pnpm") {
        expect(args).toEqual(["build:murage-cage"]);
        ready = true;
      }
    });
    const child = { on: vi.fn(), kill: vi.fn() };
    const spawnChild = vi.fn(() => { expect(ready).toBe(true); return child; });
    const say = vi.fn();
    startDevServer([], { prepare: () => prepareSourceCage({ ...base, exists: () => ready, exec, say }), spawnChild, lifecycle: { on: vi.fn() } });
    expect(say).toHaveBeenCalledOnce();
    expect(exec.mock.calls.map(([command]) => command)).toEqual(["docker", "pnpm", path.join(REPO_ROOT, "dist-native/cage/linux-x64/bwrap")]);
    expect(exec.mock.calls[1][2].cwd).toBe(REPO_ROOT);
    expect(spawnChild).toHaveBeenCalledOnce();
  });

  it.each(["docker", "build", "incomplete"])("names the exact command and requirements without starting a server (%s)", mode => {
    const exec = vi.fn(command => {
      if ((mode === "docker" && command === "docker") || (mode === "build" && command === "pnpm")) throw new Error("fixture failure");
    });
    const spawnChild = vi.fn();
    expect(() => startDevServer([], {
      prepare: () => prepareSourceCage({ ...base, exists: unbuilt, exec, say: () => {} }),
      spawnChild,
    })).toThrow(failure);
    expect(failure).toContain("`pnpm build:murage-cage`");
    expect(failure).toContain("Docker");
    expect(failure).not.toMatch(/[\r\n]/);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("reuses a complete cage and prepares a partial cage", () => {
    const exec = vi.fn();
    prepareSourceCage({ ...base, exists: built, exec });
    expect(exec).toHaveBeenCalledExactlyOnceWith(path.join(REPO_ROOT, "dist-native/cage/linux-x64/bwrap"),
      ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "true"],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 30000 });
    exec.mockClear();
    let ready = false;
    exec.mockImplementation(command => { if (command === "pnpm") ready = true; });
    prepareSourceCage({ ...base, exists: file => ready || !file.endsWith("murage-power.bpf"), exec, say: () => {} });
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[2][1]).toEqual(CAGE_SMOKE_ARGS);
  });

  it.each([
    "bwrap: setting up uid map: Permission denied",
    "bwrap: setting up uid map: Operation not permitted",
    "bwrap: unshare user ns: Operation not permitted",
    "bwrap: Creating new namespace failed: Operation not permitted",
    "bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.",
  ])("gives one AppArmor command line and does not start the server for %s", stderr => {
    const exec = vi.fn(() => { throw Object.assign(new Error("fixture denial"), { stderr: Buffer.from(`${stderr}\n`) }); });
    const read = vi.fn(() => "1\n"), say = vi.fn(), spawnChild = vi.fn();
    expect(() => startDevServer([], {
      prepare: () => prepareSourceCage({ ...base, exists: built, read, exec, say }), spawnChild,
    })).toThrow(CAGE_APPARMOR_HELP);
    expect(CAGE_APPARMOR_HELP).toContain("`pnpm cage:apparmor`");
    expect(CAGE_APPARMOR_HELP).not.toMatch(/[\r\n]/);
    expect(read).toHaveBeenCalledWith("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8");
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][0]).toBe(path.join(REPO_ROOT, "dist-native/cage/linux-x64/bwrap"));
    expect(say).not.toHaveBeenCalled();
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it.each(["disabled", "absent", "unreadable", "unrelated", "no stderr"])("keeps other smoke failures blocking without an AppArmor instruction (%s)", mode => {
    const exec = vi.fn(() => { throw Object.assign(new Error("fixture failure"), {
      stderr: mode === "unrelated" ? "bwrap: execvp true: No such file or directory" : mode === "no stderr" ? undefined : "bwrap: setting up uid map: Permission denied",
    }); });
    const read = () => { if (mode === "unreadable") throw new Error("fixture read failure"); return mode === "disabled" ? "0\n" : "1\n"; };
    const exists = file => !(mode === "absent" && file === "/sys/kernel/security/apparmor");
    const spawnChild = vi.fn();
    expect(() => startDevServer([], {
      prepare: () => prepareSourceCage({ ...base, exists, read, exec }), spawnChild,
    })).toThrow(/^Murage cage launch check did not complete;/);
    expect(spawnChild).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledOnce();
  });

  it("checks a newly built cage before starting the server", () => {
    let ready = false;
    const exec = vi.fn(command => {
      if (command === "pnpm") ready = true;
      if (command === path.join(REPO_ROOT, "dist-native/cage/linux-x64/bwrap")) {
        throw Object.assign(new Error("fixture denial"), { stderr: "bwrap: setting up uid map: Permission denied" });
      }
    });
    const spawnChild = vi.fn();
    expect(() => startDevServer([], {
      prepare: () => prepareSourceCage({ ...base, exists: () => ready, read: () => "1", exec, say: () => {} }), spawnChild,
    })).toThrow(CAGE_APPARMOR_HELP);
    expect(exec.mock.calls.map(([command]) => command)).toEqual(["docker", "pnpm", path.join(REPO_ROOT, "dist-native/cage/linux-x64/bwrap")]);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it.each([["darwin", "x64"], ["win32", "x64"], ["linux", "riscv64"]])("does no preparation on %s %s", (platform, arch) => {
    const exists = vi.fn(), exec = vi.fn();
    prepareSourceCage({ ...base, platform, arch, exists, exec });
    expect(exists).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("wires each documented source command before its app starts", () => {
    const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(scripts.dev).toBe("node scripts/prepare-source-cage.mjs && vite");
    expect(scripts.start).toBe("pnpm dev:server");
    expect(scripts["dev:server"]).toBe("node scripts/dev-server.mjs");
    expect(scripts["dev:desktop"]).toMatch(/^node scripts\/prepare-source-cage.mjs && .*electron \.$/);
  });
});

describe("the environment pnpm dev:server starts the harness with", () => {
  it("points the harness at dist/ so the browser door has a shell to serve", () => {
    // Without this the harness's STATIC_DIR is null and a phone that reaches
    // the door is proxied to a server with no UI to give it.
    const environment = devServerEnvironment("/repo", {}, built);
    expect(environment.MURAGE_STATIC_DIR).toBe(path.join("/repo", "dist"));
  });

  it("asks devHarnessEnvironment rather than deciding for itself", () => {
    // The point of the helper is that main.mjs, the Playwright webServer and
    // this script all get the same answer. A second copy of the rule here
    // would be a second copy to get wrong.
    expect(devServerEnvironment("/repo", {}, built))
      .toMatchObject(devHarnessEnvironment("/repo", built));
  });

  it("sets nothing at all in a checkout that has not been built", () => {
    // A path to a directory that is not there is worse than no path: the
    // harness already handles "no static tree", and `pnpm build` is the fix.
    expect(devServerEnvironment("/repo", {}, unbuilt).MURAGE_STATIC_DIR).toBeUndefined();
  });

  it("carries the rest of the environment through untouched", () => {
    const environment = devServerEnvironment("/repo", { MURAGE_PORT: "8799" }, built);
    expect(environment.MURAGE_PORT).toBe("8799");
  });

  it("leaves an explicit MURAGE_STATIC_DIR exactly as the person set it", () => {
    // Someone pointing the harness at a tree by hand made a deliberate
    // choice. Replacing it with dist/ would be the same class of bug as
    // never setting it: a path nobody asked for, with nothing saying so.
    const environment = devServerEnvironment("/repo", { MURAGE_STATIC_DIR: "/elsewhere/ui" }, built);
    expect(environment.MURAGE_STATIC_DIR).toBe("/elsewhere/ui");
  });

  it("resolves dist/ from the repository, not from the caller's cwd", () => {
    // `pnpm dev:server` can be run from any directory; the shell it serves
    // is the one in this checkout.
    expect(REPO_ROOT).toBe(path.resolve(import.meta.dirname, ".."));
    expect(devServerEnvironment(REPO_ROOT, {}, built).MURAGE_STATIC_DIR)
      .toBe(path.join(REPO_ROOT, "dist"));
  });

  it("still starts the same server entry the script used to run directly", () => {
    expect(SERVER_ENTRY).toBe(path.join("server", "index.ts"));
  });
});

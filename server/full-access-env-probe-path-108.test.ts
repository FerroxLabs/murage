// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated PATH shadows and a mocked spawn boundary: no executable is run.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execEnvNow, type HandedEnv } from "./engine-env.ts";
import { envGeneration, invalidateEnvCapture } from "./env-path.ts";
import { gitBashPath } from "./tool-discovery.ts";
import { piCheckForm, piPinnedBashExtension, piShellForm } from "./drivers/pi.ts";
import { execCli } from "./procs.ts";
import { autoVerdict } from "./auto-approve.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("./tool-discovery.ts", async original => ({
  ...await original<typeof import("./tool-discovery.ts")>(), gitBashPath: vi.fn(),
}));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: transport.spawn,
}));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "probe-path-108-"));
  for (const name of ["powershell.exe", "pwsh.exe", "bash.exe", "bash", "sh"]) {
    writeFileSync(join(root, name), "fixture shadow must never run", { mode: 0o755 });
  }
  invalidateEnvCapture("isolated probe path fixture");
  transport.spawn.mockReset();
  transport.spawn.mockImplementation((_file, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      const nonce = args.at(-1).match(/nonce='([a-f0-9]+)'/)?.[1];
      const output = nonce ? JSON.stringify({ version: 1, nonce, provider: "FileSystem",
        env: Object.entries(options.env), cwd: options.cwd, processCwd: options.cwd })
        : Object.entries(options.env).map(([key, value]) => `${key}=${value}\0`).join("") + `\0${options.cwd}\n`;
      child.stdout.end(output); child.stderr.end(); child.emit("close", 0, null);
    });
    return child;
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  invalidateEnvCapture("probe path fixture finished");
  removeTempDirSync(root);
});
const hand = (): HandedEnv => ({ env: { PATH: root, Path: root, HOME: root },
  absent: [], capture: "session", ownerStartup: {}, pins: new Map() });

describe("108 environment probes never search handed PATH for a shell", () => {
  it.each(["C:\\Program Files\\Git\\bin\\bash.exe", null])("checks pinned Pi bash and holds only an unpinnable shell: %s", async bash => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    vi.mocked(gitBashPath).mockResolvedValue(bash);
    const handed = hand();
    const form = await piShellForm(handed.env);
    expect(gitBashPath).toHaveBeenCalledWith(handed.env, envGeneration());
    const record = await execEnvNow("pi-path", form, handed, "C:\\work");
    expect(record.unchecked).toBeUndefined();
    if (bash) {
      expect(form).toEqual([bash, "-c"]);
      expect(record.unread).toBeUndefined();
      expect(transport.spawn.mock.calls[0]![0]).toBe(bash);
      expect(piPinnedBashExtension(bash)).toContain(`shellPath: ${JSON.stringify(bash)}`);
    } else {
      expect(record.unread?.code).toBe("U20");
      expect(transport.spawn).not.toHaveBeenCalled();
      for (const bot of [{}, { autoApprove: true }, { autoApprove: true, fullAccess: true }, { autoApprove: true, fullAccess: true, noLimits: true }]) {
        expect(autoVerdict(bot, "Bash", "echo fixture", { commandText: "echo fixture", fullAccessOrigin: "owner", envUnread: record.unread?.cause }).approve).toBeNull();
      }
    }
  });
  it("never vouches for a Pi PowerShell ask with the pinned Bash: it keeps asking at every level", async () => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
    expect(piCheckForm("Bash", [bash, "-c"])).toEqual([bash, "-c"]);
    const record = await execEnvNow("pi-pwsh", piCheckForm("PowerShell", [bash, "-c"]), hand(), "C:\\work");
    expect(record.unread?.code).toBe("U20");
    expect(record.unchecked).toBeUndefined();
    expect(transport.spawn).not.toHaveBeenCalled();
    for (const bot of [{}, { autoApprove: true }, { autoApprove: true, fullAccess: true }, { autoApprove: true, fullAccess: true, noLimits: true }]) {
      expect(autoVerdict(bot, "PowerShell", "Get-ChildItem", { commandText: "Get-ChildItem", fullAccessOrigin: "owner", envUnread: record.unread?.cause }).approve).toBeNull();
    }
  });
  // A Linux launch needs a POSIX absolute shell path, and a Windows temp folder
  // (C:\...) never is one, so this Linux case runs where its fixture is real;
  // Windows checks its own fixed paths with real shells (full-access-env-win-108).
  it.skipIf(platformDescriptor.value === "win32").each([false, true])("distinguishes a missing executable from a missing probe cwd (executable exists: %s)", async executableExists => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    transport.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      });
      queueMicrotask(() => child.emit("error", Object.assign(new Error("fixture missing path"), { code: "ENOENT" })));
      return child;
    });
    const shell = join(root, executableExists ? "bash" : "missing-shell");
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = await execEnvNow("missing-cwd", [shell, "-c"], hand(), join(root, "missing-cwd"));
      if (executableExists) {
        expect(record).toMatchObject({ env: {}, absent: [], unread: { code: "U20" } });
        if (attempt === 0) expect(record.unread?.cause).toContain("requested folder");
        expect(record.unchecked).toBeUndefined();
        for (const bot of [{}, { autoApprove: true }, { autoApprove: true, fullAccess: true }, { autoApprove: true, fullAccess: true, noLimits: true }]) {
          expect(autoVerdict(bot, "shell", "echo fixture", { commandText: "echo fixture", fullAccessOrigin: "owner", envUnread: record.unread?.cause }).approve).toBeNull();
        }
      } else {
        expect(record).toMatchObject({ env: hand().env, unchecked: { reason: "launch-failed" } });
        expect(record.unread).toBeUndefined();
      }
    }
    expect(transport.spawn).toHaveBeenCalledTimes(1);
  });
  it.each(["SIGTERM", "SIGKILL"])("keeps an outside %s non-waivable through procs and cooldown", async signal => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    transport.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      });
      queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit("close", null, signal); });
      return child;
    });
    const error = await new Promise<Error | null>(resolve => {
      execCli("/bin/sh", ["-c", "fixture"], { absoluteExecutable: true }, error => resolve(error));
    });
    expect(error).toMatchObject({ code: null, killed: false, signal });
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = await execEnvNow("outside-signal", ["/bin/sh", "-c"], hand(), "/work");
      expect(record).toMatchObject({ env: {}, absent: [], unread: { code: "U20" } });
      expect(record.unchecked).toBeUndefined();
    }
    expect(transport.spawn).toHaveBeenCalledTimes(2);
  });
  it.each([
    ["powershell.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
    ["C:\\pinned\\pwsh.exe", "C:\\pinned\\pwsh.exe"],
    ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"],
  ])("pins Windows %s despite earlier shadow executables", async (shell, expected) => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    vi.stubEnv("SystemRoot", "C:\\Windows");
    const powershell = /(?:powershell|pwsh)\.exe$/.test(shell);
    const record = await execEnvNow("windows-path", [shell, ...(powershell ? ["-NoProfile", "-Command"] : ["-c"])], hand(), "C:\\work");
    expect(record.unread).toBeUndefined(); expect(record.unchecked).toBeUndefined();
    expect(transport.spawn).toHaveBeenCalledTimes(1);
    expect(transport.spawn.mock.calls[0]![0]).toBe(expected);
    expect(transport.spawn.mock.calls[0]![2].env.PATH).toBe(root);
  });
  it.each(["sh", "bash", "/bin/sh", "/bin/bash", "/pinned/shell"])("pins POSIX %s despite earlier shadow executables", async shell => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    const record = await execEnvNow("posix-path", [shell, "-c"], hand(), "/work");
    expect(record.unread).toBeUndefined(); expect(record.unchecked).toBeUndefined();
    expect(transport.spawn).toHaveBeenCalledTimes(1);
    expect(transport.spawn.mock.calls[0]![0]).toBe(shell.startsWith("/") ? shell : `/bin/${shell}`);
  });
  it.each([
    ["powershell.exe", "relative-windows"], ["powershell.exe", ""], ["powershell.exe", "C:Windows"],
    ["powershell.exe", "\\Windows"], ["pwsh.exe", "C:\\Windows"], ["bash.exe", "C:\\Windows"],
    [".\\bash.exe", "C:\\Windows"],
  ])("holds an unpinned Windows %s (SystemRoot=%s), including cooldown", async (shell, systemRoot) => {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    vi.stubEnv("SystemRoot", systemRoot);
    const form = [shell, ...(/(?:powershell|pwsh)\.exe$/.test(shell) ? ["-NoProfile", "-Command"] : ["-c"])];
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = await execEnvNow("unresolved", form, hand(), "C:\\work");
      expect(record.unchecked).toBeUndefined(); expect(record.unread?.code).toBe("U20");
      for (const bot of [{}, { autoApprove: true }, { autoApprove: true, fullAccess: true }, { autoApprove: true, fullAccess: true, noLimits: true }]) {
        expect(autoVerdict(bot, "shell", "echo fixture", { commandText: "echo fixture", fullAccessOrigin: "owner", envUnread: record.unread?.cause }).approve).toBeNull();
      }
    }
    expect(transport.spawn).not.toHaveBeenCalled();
  });
});

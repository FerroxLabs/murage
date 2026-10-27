// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// S4 power, docs/designs/S4-POWER-STRUCTURAL-108.md revision 4.1, section 10. No test powers a machine: nothing here calls
// reboot, shutdown, pmset, ExitWindowsEx, SetSuspendState or a power Apple event, and the bus checks connect only to the stub.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cloud = vi.hoisted(() => ({ marker: "murage-cloud-marker" }));
// The addon procs.ts asks for the Windows privilege removal: the real lookup unless a test puts a stand-in here.
const addonState = vi.hoisted(() => ({ addon: undefined as unknown }));
vi.mock("./engine-exclusion.ts", async (original) => {
  const actual = await original<typeof import("./engine-exclusion.ts")>();
  return { ...actual, loadExclusionAddon: () => (addonState.addon === undefined ? actual.loadExclusionAddon() : addonState.addon) };
});
vi.mock("./cloud-home/turn-process.ts", async (original) => {
  const actual = await original<typeof import("./cloud-home/turn-process.ts")>();
  // A cloud launch for one marker command: the launcher stands in for the engine (procs.ts spawnCli), and it is not wrapped.
  return { ...actual, cloudTurnLaunch: (command: string, ...rest: unknown[]) => (command.endsWith(cloud.marker)
    ? { command: "/bin/sh", args: ["-c", "cat >/dev/null; exit 0"], unit: "murage-test", request: "{}" }
    : (actual.cloudTurnLaunch as (...a: unknown[]) => unknown)(command, ...rest)) };
});

import {
  BWRAP_ARGS_FD, BWRAP_ENVIRONMENT, BWRAP_STATUS_FD, bwrapEngineStarted, HOST_POWER_CODE, HOST_POWER_MESSAGE, HOST_POWER_MESSAGE_LINUX_MAC, HOST_POWER_MESSAGE_WINDOWS, HOST_POWER_TEST_UNWRAPPED, POWER_FILTER_SHA256, SEATBELT_POWER_PROFILE,
  bwrapOptions, bwrapEarlyExitMessage, closePowerFilter, hostPowerDeps, openPowerFilter, planHostPower, sessionBusPaths, startHostPowerStub, stopHostPowerStubForTests,
} from "./host-power.ts";
import { awaitCliTreeStopped, cliTreeConfirmedStopped, cliTreeStoppedSignal, dropServerShutdownPrivileges, engineJob, engineProcessPid, engineWrapsHostPower, forceCliTreeStopped, hostPowerKeyField, hostPowerRefused, killCliTree, resetShutdownDropForTests, spawnCli } from "./procs.ts";
import { diffWarmKey, warmKey } from "./drivers/warm-key.ts";
import { codexTurnPolicy } from "./drivers/codex-isolation.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const asPlatform = <T>(platform: NodeJS.Platform, run: () => T): T => {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  try { return run(); } finally { Object.defineProperty(process, "platform", platformDescriptor); }
};
const realDeps = { ...hostPowerDeps };
const dirs: string[] = [];
const scratch = (prefix = "murage-power-test-") => { const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(dir); return dir; };
const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
/** The stand-in filter's bytes and the pin the fake cages are checked against (hostPowerDeps.powerFilterSha256). */
const FAKE_BPF = Buffer.alloc(8);
const FAKE_PIN = sha256(FAKE_BPF);

/** A helper folder with a bwrap stand-in (a shell script, or a full file when `whole`), a filter file and the cage manifest naming
 *  both, all not writable per the writable seam. The power filter pin is the stand-in's for the rest of the test. */
function fakeCage(script: string, options: { whole?: boolean; bpf?: Buffer; source?: boolean; arch?: string; pin?: string } = {}): string {
  const arch = options.arch ?? process.arch, pin = options.pin ?? FAKE_PIN;
  const root = scratch("murage-cage-");
  const dir = options.source ? join(root, "dist-native", "cage", `linux-${arch}`) : root;
  if (options.source) mkdirSync(dir, { recursive: true });
  const bwrap = options.whole ? script : `#!/bin/sh\n${script}\n`;
  writeFileSync(join(dir, "bwrap"), bwrap);
  chmodSync(join(dir, "bwrap"), 0o755);
  writeFileSync(join(dir, "murage-power.bpf"), options.bpf ?? FAKE_BPF);
  chmodSync(join(dir, "murage-power.bpf"), 0o644);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 1, target: `linux-${arch}`, executable: "bwrap", binarySha256: sha256(bwrap), filters: { "murage-power.bpf": { sha256: pin } } }));
  hostPowerDeps.powerFilterSha256 = (target) => (target === arch ? pin : null);
  return dir;
}
/** What a bwrap stand-in writes to its status fd as the real one does: the child-pid record once the sandbox exists, and the
 *  exit-code record (only after the engine was exec'd) as it ends with the engine's code. */
const STARTED = (code = 0) => `printf '{ "child-pid": 2 }\\n{ "exit-code": ${code} }\\n' >&${BWRAP_STATUS_FD}`;
/** The options bwrap reads from its --args pipe. */
const optionsOf = (data: Buffer): string[] => { const text = data.toString("utf8"); expect(text.endsWith("\0")).toBe(true); return text.slice(0, -1).split("\0"); };

beforeEach(() => {
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = false;
});
afterEach(() => {
  Object.assign(hostPowerDeps, realDeps);
  (globalThis as Record<symbol, unknown>)[HOST_POWER_TEST_UNWRAPPED] = true;
  vi.restoreAllMocks();
});
afterAll(async () => {
  await stopHostPowerStubForTests();
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("where the block is applied (section 2)", () => {
  it("Mac and Linux: a wrapped spawn carries hostPower and no job; Claude, Codex and Fuigo pass posixHostPower false and carry nothing", () => {
    for (const platform of ["linux", "darwin"] as const) asPlatform(platform, () => {
      expect(engineJob()).toEqual({ hostPower: true });
      expect(engineJob({ posixHostPower: false })).toBeUndefined();
      expect(engineWrapsHostPower()).toBe(true);
      expect(engineWrapsHostPower({ posixHostPower: false })).toBe(false);
    });
  });

  it("Windows: every engine spawn is a named job that also sets hostPower; Claude, Codex and Fuigo are not exempt", () => {
    asPlatform("win32", () => {
      for (const job of [engineJob(), engineJob({ posixHostPower: false })]) expect(job).toEqual({ name: expect.stringMatching(/^Local\\murage-pip-eng-/), hostPower: true });
      expect(engineWrapsHostPower({ posixHostPower: false })).toBe(true);
    });
  });

  it("the drivers mark their spawns as the design says", () => {
    const claude = source("drivers/claude.ts"), codex = source("drivers/codex.ts"), acp = source("drivers/acp/core.ts"), antigravity = source("drivers/antigravity.ts"), pi = source("drivers/pi.ts");
    // Claude turn and review spawns: the Windows job, no hostPower on Mac or Linux.
    expect(claude.match(/engineJob\(\{ posixHostPower: false \}\)/g)).toHaveLength(2);
    expect(claude).not.toMatch(/engineJob\(\)\)/);
    // Codex: Windows only (revision 4.1).
    expect(codex).toContain("}, engineJob({ posixHostPower: false }));");
    // ACP: Fuigo is not wrapped on Mac or Linux, every other ACP engine is.
    expect(acp).toContain('const hostPowerOptions = { posixHostPower: support.driverKind !== "fuigoAgent" };');
    expect(acp).toContain("}, engineJob(hostPowerOptions));");
    // Antigravity: the turn and the helper prompt pass engineJob() on every OS; Pi's turn too.
    expect(antigravity.match(/engineJob\(\)/g)!.length).toBeGreaterThanOrEqual(2);
    expect(pi).toContain("}, engineJob());");
    // The block does not read the channel flag, and this phase does not edit auto-approve.ts.
    expect(source("host-power.ts")).not.toContain("fullAccessChannelMessages");
  });

  it("the version probes and catalog spawns named in section 2 pass no engine job", () => {
    for (const [file, line] of [["drivers/pi.ts", "spawnCli(cli, PI_ARGS, { stdio"], ["drivers/codex-catalog.ts", 'spawnCli(cli, ["app-server"]'], ["mcp-probe.ts", "spawnCli(server.command, server.args"], ["fuigo-native-update.ts", "spawnCli(command, [...prefix"]] as const) {
      const text = source(file);
      const at = text.indexOf(line);
      expect(at).toBeGreaterThan(-1);
      expect(text.slice(at, text.indexOf(");", at))).not.toContain("engineJob");
    }
  });
});

describe("Codex keeps its own sandbox on Linux and macOS (revision 4.1)", () => {
  it("sends the unchanged codexTurnPolicy strings on every OS", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) asPlatform(platform, () => {
      expect(codexTurnPolicy("9.0.0", { proposalOnly: false, fullAuto: false }).sandbox).toBe("workspace-write");
      expect(codexTurnPolicy("9.0.0", { proposalOnly: true, fullAuto: false }).sandbox).toBe("read-only");
      expect(codexTurnPolicy("9.0.0", { proposalOnly: true, fullAuto: true }).sandbox).toBe("read-only");
      expect(codexTurnPolicy("9.0.0", { proposalOnly: false, fullAuto: true }).sandbox).toBe("danger-full-access");
      expect(codexTurnPolicy("0.1.0", { proposalOnly: false, fullAuto: false }).sandbox).toBe("workspaceWrite");
      expect(codexTurnPolicy("0.1.0", { proposalOnly: true, fullAuto: false }).sandbox).toBe("readOnly");
      expect(codexTurnPolicy("0.1.0", { proposalOnly: false, fullAuto: true }).sandbox).toBe("dangerFullAccess");
    });
  });
});

describe("reuse (section 7)", () => {
  const parts = { bot: "b", thread: "t", args: ["--x"] };
  it("a key under the block differs from the same key without it in exactly the hostPower field", () => {
    asPlatform("win32", () => {
      const wrapped = warmKey({ ...parts, ...hostPowerKeyField({ posixHostPower: false }) });
      expect(diffWarmKey(wrapped, warmKey(parts))).toBe("hostPower");
    });
  });
  it("Claude, Codex and Fuigo keys on Linux and macOS carry no hostPower field; a wrapped engine's key carries the constant", () => {
    for (const platform of ["linux", "darwin"] as const) asPlatform(platform, () => {
      expect(hostPowerKeyField({ posixHostPower: false })).toEqual({});
      expect(hostPowerKeyField()).toEqual({ hostPower: 1 });
    });
    expect(source("drivers/claude.ts")).toContain("...hostPowerKeyField({ posixHostPower: false }),");
    expect(source("drivers/codex.ts")).toContain("...hostPowerKeyField({ posixHostPower: false }),");
    expect(source("drivers/acp/core.ts")).toContain("...(engineWrapsHostPower(hostPowerOptions) ? [{ hostPower: 1 }] : []),");
  });
});

describe("Linux plan (section 4)", () => {
  let stub: string;
  beforeAll(async () => { if (process.platform !== "win32") stub = (await startHostPowerStub())!; });
  const linux = (dir: string | null, arch: string = process.arch) => Object.assign(hostPowerDeps, {
    platform: () => "linux" as const, arch: () => arch, geteuid: () => 1000, getegid: () => 1000, helperDir: () => dir, writable: () => false,
  });

  it("names the cage build command and Docker when bwrap is missing", () => {
    linux(null);
    expect(planHostPower("/usr/bin/engine", [], {}, "/")).toEqual({
      kind: "refuse",
      reason: "the shipped bwrap is missing: run `pnpm build:murage-cage` (needs Docker and the Linux build tools)",
    });
  });

  it.skipIf(process.platform === "win32")("builds the bwrap argv in the design's order, PATH-only bwrap environment, the turn env inside", () => {
    const dir = fakeCage("exit 0");
    linux(dir);
    const plan = planHostPower("/usr/bin/engine", ["--flag", "echo reboot"], { HOME: "/home/u", PATH: "/usr/bin", DBUS_SESSION_BUS_ADDRESS: `unix:path=${stub}` }, "/work");
    expect(plan.kind).toBe("bwrap");
    if (plan.kind !== "bwrap") return;
    expect(plan.command).toBe(join(dir, "bwrap"));
    expect(plan.env).toEqual(BWRAP_ENVIRONMENT);
    expect(plan.env).toEqual({ PATH: "/usr/bin:/bin" });
    expect(plan.bpfSha256).toBe(FAKE_PIN);
    // bwrap's visible argv is only the --args fd and the engine argv; every option rides the pipe.
    expect(plan.args).toEqual(["--args", String(BWRAP_ARGS_FD), "--", "/usr/bin/engine", "--flag", "echo reboot"]);
    const a = [...optionsOf(plan.argsData), "--", "/usr/bin/engine", "--flag", "echo reboot"];
    expect(a.slice(0, 11)).toEqual(["--unshare-user", "--uid", "1000", "--gid", "1000", "--unshare-pid", "--cap-drop", "ALL", "--die-with-parent", "--new-session", "--bind"]);
    const order = ["--bind", "--dev", "--proc", "--ro-bind", "--seccomp", "--chdir", "--clearenv", "--"].map((flag) => a.indexOf(flag));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(a.slice(a.indexOf("--bind"), a.indexOf("--bind") + 3)).toEqual(["--bind", "/", "/"]);
    expect(a.slice(a.indexOf("--dev"), a.indexOf("--dev") + 2)).toEqual(["--dev", "/dev"]);
    expect(a.slice(a.indexOf("--proc"), a.indexOf("--proc") + 2)).toEqual(["--proc", "/proc"]);
    expect(a.slice(a.indexOf("--ro-bind"), a.indexOf("--ro-bind") + 3)).toEqual(["--ro-bind", dir, dir]);
    expect(a.slice(a.indexOf("--seccomp"), a.indexOf("--seccomp") + 2)).toEqual(["--seccomp", "3"]);
    expect(a.slice(a.indexOf("--chdir"), a.indexOf("--chdir") + 2)).toEqual(["--chdir", "/work"]);
    // The session bus path (here the stub itself, which exists) is covered by the stub inode.
    expect(a).toEqual(expect.arrayContaining(["--bind", stub, stub]));
    for (const absent of ["--unshare-net", "--dev-bind", "--tmpfs"]) expect(a).not.toContain(absent);
    // The engine argv is unchanged after "--"; a word in it is not rewritten.
    expect(a.slice(a.indexOf("--") + 1)).toEqual(["/usr/bin/engine", "--flag", "echo reboot"]);
    const setenv = a.slice(a.indexOf("--clearenv") + 1, a.indexOf("--"));
    expect(setenv).toEqual(expect.arrayContaining(["--setenv", "HOME", "/home/u"]));
  });

  it.skipIf(process.platform === "win32").each(["x64", "arm64"])("plans %s with its production pin and rejects a missing pin or the other target", (arch) => {
    const dir = fakeCage("exit 0", { arch, pin: POWER_FILTER_SHA256[arch] });
    linux(dir, arch);
    hostPowerDeps.powerFilterSha256 = realDeps.powerFilterSha256;
    expect(planHostPower("/usr/bin/engine", [], {}, "/")).toMatchObject({ kind: "bwrap", bpfSha256: POWER_FILTER_SHA256[arch] });
    hostPowerDeps.powerFilterSha256 = () => null;
    expect(planHostPower("/usr/bin/engine", [], {}, "/")).toEqual({ kind: "refuse", reason: `architecture ${arch} has no power filter` });
    hostPowerDeps.powerFilterSha256 = realDeps.powerFilterSha256;
    hostPowerDeps.arch = () => arch === "x64" ? "arm64" : "x64";
    expect(planHostPower("/usr/bin/engine", [], {}, "/").kind).toBe("refuse");
  });

  it("covers the system and user bus paths that exist, and no others", () => {
    const runtime = scratch();
    writeFileSync(join(runtime, "bus"), "");
    const args = bwrapOptions({ euid: 1, egid: 1, helperDir: "/h", stub: "/s", busPaths: [join(runtime, "bus")], bpfFd: 3, cwd: "/", env: {} });
    expect(args).toEqual(expect.arrayContaining(["--bind", "/s", join(runtime, "bus")]));
    expect(sessionBusPaths("unix:path=/run/user/1/bus;unix:abstract=/tmp/x")).toEqual({ paths: ["/run/user/1/bus"], abstract: true });
    expect(sessionBusPaths("unix:path=/run/user/1/bus")).toEqual({ paths: ["/run/user/1/bus"], abstract: false });
  });

  it.skipIf(process.platform === "win32")("no turn environment value is on bwrap's argv; every one reaches the --args payload as --clearenv then --setenv", () => {
    const dir = fakeCage("exit 0");
    linux(dir);
    const env = { CLINE_API_KEY: "sk-cline-secret-1", MURAGE_PI_GATE: "gate-secret-2", EMPTY: "", SPACED: "a b=c", PATH: "/opt/turn-path/bin" };
    const plan = planHostPower("/usr/bin/engine", ["--flag"], env, "/work");
    expect(plan.kind).toBe("bwrap");
    if (plan.kind !== "bwrap") return;
    const visible = [plan.command, ...plan.args].join("\0");
    for (const [name, value] of Object.entries(env)) {
      if (value) expect(visible).not.toContain(value);
      expect(plan.args).not.toContain(name);
    }
    expect(plan.args).not.toContain("--setenv");
    expect(plan.args).not.toContain("--clearenv");
    const options = optionsOf(plan.argsData);
    const clear = options.indexOf("--clearenv");
    expect(clear).toBeGreaterThan(-1);
    const pairs: Record<string, string> = {};
    for (let i = clear + 1; i < options.length; i += 3) { expect(options[i]).toBe("--setenv"); pairs[options[i + 1]] = options[i + 2]; }
    expect(pairs).toEqual(env);
  });

  it.skipIf(process.platform === "win32")("checks the bytes: the bpf pin matches POWER-BPF-HASHES.txt, a cage manifest that names other bytes or another filter is refused", () => {
    const pins = readFileSync(new URL("../native/power-seccomp/POWER-BPF-HASHES.txt", import.meta.url), "utf8");
    expect(POWER_FILTER_SHA256).toEqual({
      x64: /^x86_64\s+([a-f0-9]{64})\s*$/m.exec(pins)![1],
      arm64: /^aarch64\s+([a-f0-9]{64})\s*$/m.exec(pins)![1],
    });
    expect(POWER_FILTER_SHA256.x64).toBe("72cf57db4cd8ff5ec32f5a477be727ac0cfa29d8a9b240515dc4fb2504aed4a6");
    expect(realDeps.powerFilterSha256("x64")).toBe(POWER_FILTER_SHA256.x64);
    expect(POWER_FILTER_SHA256.arm64).toBe("ed3bd9b4e5761211665c25c00153aaf1de2c21851a414c5e76ef689c7eb06c3a");
    expect(realDeps.powerFilterSha256("arm64")).toBe(POWER_FILTER_SHA256.arm64);
    expect(realDeps.powerFilterSha256("riscv64")).toBeNull();
    const kind = () => planHostPower("/usr/bin/engine", [], {}, "/").kind;
    // A bwrap whose bytes are not the manifest's.
    let dir = fakeCage("exit 0"); linux(dir); expect(kind()).toBe("bwrap");
    writeFileSync(join(dir, "bwrap"), "#!/bin/sh\nexit 0 # replaced\n"); expect(kind()).toBe("refuse");
    // A manifest that names a filter other than this server's pin.
    dir = fakeCage("exit 0"); linux(dir); hostPowerDeps.powerFilterSha256 = () => POWER_FILTER_SHA256[process.arch]; expect(kind()).toBe("refuse");
    // No manifest, a writable manifest, a manifest for another target.
    dir = fakeCage("exit 0"); linux(dir); writeFileSync(join(dir, "manifest.json"), "{}"); expect(kind()).toBe("refuse");
    dir = fakeCage("exit 0"); linux(dir); hostPowerDeps.writable = (file) => file.endsWith("manifest.json"); expect(kind()).toBe("refuse");
    dir = fakeCage("exit 0"); linux(dir);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, target: process.arch === "arm64" ? "linux-x64" : "linux-arm64" })); expect(kind()).toBe("refuse");
    // A NUL inside a turn value would split into extra bwrap options: refused.
    dir = fakeCage("exit 0"); linux(dir);
    expect(planHostPower("/usr/bin/engine", [], { X: "a\0--bind\0/\0/" }, "/").kind).toBe("refuse");
  });

  it.skipIf(process.platform === "win32")("openPowerFilter hashes through the fd it returns, leaves its offset at 0, and refuses other bytes", () => {
    const dir = fakeCage("exit 0", { bpf: Buffer.from("0123456789abcdef") });
    const file = join(dir, "murage-power.bpf");
    expect(openPowerFilter(file, FAKE_PIN)).toBeNull();
    const fd = openPowerFilter(file, sha256(Buffer.from("0123456789abcdef")));
    expect(fd).not.toBeNull();
    try {
      const head = Buffer.alloc(16);
      // A read at the fd's own offset (position null) still starts at byte 0: bwrap reads the whole filter.
      expect(readSync(fd!, head, 0, 16, null)).toBe(16);
      expect(head.toString()).toBe("0123456789abcdef");
    } finally { closePowerFilter(fd!); }
    expect(openPowerFilter(join(dir, "missing.bpf"), FAKE_PIN)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses before spawn: missing or writable helper, euid 0, abstract session bus, argv over 1 MiB, unbound stub, other architecture", () => {
    const dir = fakeCage("exit 0");
    const refused = (env: NodeJS.ProcessEnv = {}, args: string[] = []) => planHostPower("/usr/bin/engine", args, env, "/").kind === "refuse";
    linux(null); expect(refused()).toBe(true);
    linux(dir); expect(refused()).toBe(false);
    linux(dir); hostPowerDeps.writable = () => true; expect(refused()).toBe(true);
    linux(dir); hostPowerDeps.geteuid = () => 0; expect(refused()).toBe(true);
    linux(dir); expect(refused({ DBUS_SESSION_BUS_ADDRESS: "unix:abstract=/tmp/dbus-x" })).toBe(true);
    linux(dir); expect(refused({}, ["x".repeat(1024 * 1024)])).toBe(true);
    linux(dir); hostPowerDeps.arch = () => "ia32"; expect(refused()).toBe(true);
    // An unsupported ABI is refused even with an injected pin.
    linux(dir); hostPowerDeps.arch = () => "riscv64"; hostPowerDeps.powerFilterSha256 = () => FAKE_PIN; expect(refused()).toBe(true);
    hostPowerDeps.powerFilterSha256 = () => FAKE_PIN;
    linux(dir); hostPowerDeps.stubSocket = () => null; expect(refused()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("the stub accepts and closes: a connection to it gets no answer", async () => {
    const closed = await new Promise<boolean>((resolve) => {
      const socket = createConnection(stub);
      let data = false;
      socket.on("data", () => { data = true; });
      socket.on("error", () => resolve(true));
      socket.on("close", () => resolve(!data));
    });
    expect(closed).toBe(true);
  });
});

describe("macOS plan (section 5)", () => {
  it("runs sandbox-exec -p with the fixed profile, the engine argv unchanged; a missing sandbox-exec is refused", () => {
    Object.assign(hostPowerDeps, { platform: () => "darwin" as const, sandboxExec: "/bin/sh" });
    const plan = planHostPower("/usr/local/bin/engine", ["a", "echo reboot"], {}, "/");
    expect(plan).toEqual({ kind: "seatbelt", command: "/bin/sh", args: ["-p", SEATBELT_POWER_PROFILE, "/usr/local/bin/engine", "a", "echo reboot"] });
    hostPowerDeps.sandboxExec = join(scratch(), "no-sandbox-exec");
    expect(planHostPower("/usr/local/bin/engine", [], {}, "/").kind).toBe("refuse");
    expect(SEATBELT_POWER_PROFILE).not.toMatch(/\/Users|\/home|\/tmp/);
    for (const name of ["com.apple.logind", "com.apple.PowerManagement.control", "com.apple.iokit.powerdxpc", "IOPMrootDomain", "RootDomainUserClient", "com.apple.loginwindow", "com.apple.systemevents", "com.apple.finder", "(allow default)"]) expect(SEATBELT_POWER_PROFILE).toContain(name);
  });
});

describe("source cage AppArmor launch guidance", () => {
  const command = "/home/developer/checkout/dist-native/cage/linux-x64/bwrap";
  const denial = "bwrap: setting up uid map: Permission denied";
  const original = `the bundled bwrap ended (exit 1) before the engine started, so the power block was not in place: ${denial}`;
  beforeEach(() => Object.assign(hostPowerDeps, { platform: () => "linux", arch: () => "x64" }));

  it.each([
    denial,
    "bwrap: setting up uid map: Operation not permitted",
    "bwrap: unshare user ns: Operation not permitted",
    "bwrap: Creating new namespace failed: Operation not permitted",
    "bwrap: No permissions to create a new namespace",
  ])("names the one-time command for a source user namespace denial: %s", stderr => {
    const message = bwrapEarlyExitMessage("exit 1", stderr, command, {});
    expect(message).toContain("Run `pnpm cage:apparmor` once from this repository");
    expect(message).not.toMatch(/[\r\n]/);
  });

  it.each(["MURAGE_PACKAGED", "MURAGE_RESOURCES_PATH", "OMB_RESOURCES_PATH"])("preserves packaged wording with %s", key => {
    expect(bwrapEarlyExitMessage("exit 1", denial, command, { [key]: "fixture" })).toBe(original);
  });

  it("preserves the packaged-path wording even without environment markers", () => {
    expect(bwrapEarlyExitMessage("exit 1", denial, "/opt/Murage/resources/cage/bwrap", {})).toBe(original);
  });

  it.each(["darwin", "win32"] as const)("does not suggest AppArmor on %s", platform => {
    hostPowerDeps.platform = () => platform;
    expect(bwrapEarlyExitMessage("exit 1", denial, command, {})).toBe(original);
  });

  it.each(["", "bwrap: execvp engine: No such file or directory", "bwrap: Can't mkdir /tmp/example: Permission denied"])("keeps unrelated early exits unchanged (%s)", stderr => {
    expect(bwrapEarlyExitMessage("exit 1", stderr, command, {})).toBe(
      `the bundled bwrap ended (exit 1) before the engine started, so the power block was not in place${stderr ? `: ${stderr}` : ""}`,
    );
  });
});

describe("spawnCli with the block (sections 2 and 8)", () => {
  const collect = (child: ReturnType<typeof spawnCli>) => new Promise<{ errors: NodeJS.ErrnoException[]; code: number | null; out: string; err: string }>((resolve) => {
    const errors: NodeJS.ErrnoException[] = [];
    let out = "", err = "";
    let done = false;
    const end = (code: number | null) => { if (!done) { done = true; resolve({ errors, code, out, err }); } };
    // A spawn that never started (docker absent: ENOENT) may not reach close; nothing is left to wait for then.
    child.on("error", (error) => { errors.push(error); if (child.pid === undefined) setTimeout(() => end(null), 200); });
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("close", (code) => end(code));
    try { child.stdin.end(); } catch { /* a refused launch's stand-in pipe */ }
  });

  it.skipIf(process.platform !== "linux")("a refused Linux launch has no pid, EPOWER and the sentence, and is not ECONTAIN", async () => {
    Object.assign(hostPowerDeps, { helperDir: () => null });
    const child = spawnCli("/bin/true", [], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
    expect(child.pid).toBeUndefined();
    const result = await collect(child);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe(HOST_POWER_CODE);
    expect(result.errors[0].code).not.toBe("ECONTAIN");
    expect(result.errors[0].message).toBe(HOST_POWER_MESSAGE);
    expect(result.code).toBe(-2);
    expect(hostPowerRefused(child)).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("a wrapped Linux launch runs the shipped bwrap with PATH only and the filter on fd 3, the engine argv after --", async () => {
    await startHostPowerStub();
    // The stand-in prints whether fd 3 is open, its own environment, its own /proc cmdline (what any local user can read), then
    // the --args payload it reads from fd 4.
    const dir = fakeCage(`[ -e /proc/self/fd/3 ] && echo fd3; env | sort; echo CMDLINE; tr "\\0" "\\n" </proc/$$/cmdline; echo PAYLOAD; tr "\\0" "\\n" <&4; echo END; ${STARTED()}`);
    Object.assign(hostPowerDeps, { helperDir: () => dir, writable: () => false });
    const secret = "sk-turn-secret-value-7f3a";
    const child = spawnCli("/bin/true", ["echo reboot"], { stdio: ["pipe", "pipe", "pipe"], env: { SECRET_TURN: secret, PATH: "/usr/bin" } }, { hostPower: true });
    expect(child.pid).toBeGreaterThan(0);
    const result = await collect(child);
    expect(result.code).toBe(0);
    const lines = result.out.split("\n");
    expect(lines).toContain("fd3");
    expect(lines).toContain("PATH=/usr/bin:/bin");
    expect(lines.filter((line) => line.startsWith("SECRET_TURN="))).toEqual([]); // the turn's env is not bwrap's
    const cmdline = lines.slice(lines.indexOf("CMDLINE") + 1, lines.indexOf("PAYLOAD"));
    expect(cmdline).toEqual(["/bin/sh", join(dir, "bwrap"), "--args", String(BWRAP_ARGS_FD), "--", "/bin/true", "echo reboot"]);
    expect(cmdline.join("\n")).not.toContain(secret);
    expect(cmdline).not.toContain("--setenv");
    const payload = lines.slice(lines.indexOf("PAYLOAD") + 1, lines.indexOf("END"));
    expect(payload).toContain("--clearenv");
    const at = payload.indexOf("SECRET_TURN");
    expect(payload.slice(at - 1, at + 2)).toEqual(["--setenv", "SECRET_TURN", secret]);
    expect(payload.slice(payload.indexOf("--seccomp"), payload.indexOf("--seccomp") + 2)).toEqual(["--seccomp", "3"]);
    expect(payload.slice(payload.indexOf("--json-status-fd"), payload.indexOf("--json-status-fd") + 2)).toEqual(["--json-status-fd", String(BWRAP_STATUS_FD)]);
    expect(hostPowerRefused(child)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("the engine still receives the turn environment, exactly: a stand-in that applies --args the way bwrap does", async () => {
    await startHostPowerStub();
    // A Node stand-in for bwrap: it reads its options from the --args fd, applies --clearenv/--setenv, then runs the engine argv
    // after "--" with that environment (the real bwrap is the section 10 fixture below).
    const standIn = `#!${process.execPath}
const fs = require("fs"), cp = require("child_process");
const argv = process.argv.slice(2);
if (argv[0] !== "--args") process.exit(90);
const options = fs.readFileSync(Number(argv[1])).toString("utf8").split("\\0"); options.pop();
let env = { ...process.env };
for (let i = 0; i < options.length; i++) {
  if (options[i] === "--clearenv") env = {};
  else if (options[i] === "--setenv") { env[options[i + 1]] = options[i + 2]; i += 2; }
}
const rest = argv.slice(argv.indexOf("--") + 1);
const r = cp.spawnSync(rest[0], rest.slice(1), { env, stdio: "inherit" });
fs.writeSync(${BWRAP_STATUS_FD}, '{ "child-pid": 2 }\\n{ "exit-code": ' + (r.status ?? 91) + ' }\\n');
process.exit(r.status ?? 91);
`;
    const dir = fakeCage(standIn, { whole: true });
    Object.assign(hostPowerDeps, { helperDir: () => dir, writable: () => false });
    const env = { CLINE_API_KEY: "sk-cline-secret-1", MURAGE_PI_GATE: "gate-secret-2", EMPTY: "", SPACED: "a b=c", PATH: "/usr/bin:/bin" };
    const child = spawnCli("/usr/bin/env", [], { stdio: ["pipe", "pipe", "pipe"], env }, { hostPower: true });
    const result = await collect(child);
    expect(result.code).toBe(0);
    expect(hostPowerRefused(child)).toBe(false);
    const seen =Object.fromEntries(result.out.split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    expect(seen).toEqual(env);
  });

  it.skipIf(process.platform !== "linux")("a filter whose bytes are not the pin at spawn is refused with EPOWER, no pid", async () => {
    await startHostPowerStub();
    // The manifest names the pin, the file on disk holds other bytes: the plan passes, the fd hash refuses.
    const dir = fakeCage("exit 0", { bpf: Buffer.alloc(16, 1) });
    Object.assign(hostPowerDeps, { helperDir: () => dir, writable: () => false });
    const child = spawnCli("/bin/true", [], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
    expect(child.pid).toBeUndefined();
    const result = await collect(child);
    expect(result.errors.map((error) => [error.code, error.message])).toEqual([[HOST_POWER_CODE, HOST_POWER_MESSAGE]]);
    expect(hostPowerRefused(child)).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("a bwrap that starts and then refuses has a pid, exits, and reads as the block refusal (not Node's spawn error)", async () => {
    await startHostPowerStub();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // the cage is staged for the arch the test pins (x64), so its pin is found on an arm64 host too
    const dir = fakeCage('echo "bwrap: setting up uid map: Permission denied" >&2; exit 1', { source: true, arch: "x64" });
    Object.assign(hostPowerDeps, { helperDir: () => dir, writable: () => false, arch: () => "x64" });
    const child = spawnCli("/bin/true", [], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
    expect(child.pid).toBeGreaterThan(0);
    const result = await collect(child);
    expect(result.errors).toHaveLength(0);
    expect(result.code).toBe(1);
    expect(hostPowerRefused(child)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Run `pnpm cage:apparmor` once from this repository"));
  });

  it.skipIf(process.platform !== "linux")("an engine that exits non-zero on its own is not the block refusal", async () => {
    await startHostPowerStub();
    const dir = fakeCage(`echo "engine: bad flag" >&2; ${STARTED(2)}; exit 2`);
    Object.assign(hostPowerDeps, { helperDir: () => dir, writable: () => false });
    const child = spawnCli("/bin/true", [], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
    expect((await collect(child)).code).toBe(2);
    expect(hostPowerRefused(child)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("an engine that prints bwrap-looking text and then ran is not the refusal: the status record decides, not stderr", async () => {
    await startHostPowerStub();
    const dir = fakeCage(`echo "bwrap: this line came from the engine" >&2; ${STARTED(1)}; exit 1`);
    Object.assign(hostPowerDeps, { helperDir: () => dir, writable: () => false });
    const child = spawnCli("/bin/true", [], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
    expect((await collect(child)).code).toBe(1);
    expect(hostPowerRefused(child)).toBe(false);
  });

  // The bwrap stage failing before the engine started, in the ways that do not print "bwrap: ": each is the block refusal.
  for (const [name, script] of [
    ["the dynamic loader cannot start bwrap (an older distro without GLIBC_2.38)",
      "echo \"/opt/Murage/resources/cage/bwrap: /lib/x86_64-linux-gnu/libc.so.6: version \\`GLIBC_2.38' not found (required by /opt/Murage/resources/cage/bwrap)\" >&2; exit 1"],
    ["bwrap cannot be executed by the kernel", "echo \"/opt/Murage/resources/cage/bwrap: cannot execute binary file: Exec format error\" >&2; exit 126"],
    ["bwrap ends silently", "exit 127"],
    ["the sandbox started but execvp of the engine failed (child-pid record only)", `printf '{ "child-pid": 2 }\\n' >&${BWRAP_STATUS_FD}; echo "bwrap: execvp /usr/bin/engine: No such file or directory" >&2; exit 1`],
    ["bwrap exits 0 without the exit-code record", "exit 0"],
  ] as const) {
    it.skipIf(process.platform !== "linux")(`${name}: the EPOWER refusal, never a broken engine`, async () => {
      await startHostPowerStub();
      const dir = fakeCage(script);
      Object.assign(hostPowerDeps, { helperDir: () => dir, writable: () => false });
      const child = spawnCli("/bin/true", [], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
      expect(child.pid).toBeGreaterThan(0);
      const result = await collect(child);
      expect(result.errors).toHaveLength(0);
      expect(hostPowerRefused(child)).toBe(true);
    });
  }

  it.skipIf(process.platform !== "linux")("a wrapped run Murage stops before the engine started is a stop, not the refusal", async () => {
    await startHostPowerStub();
    const dir = fakeCage("exec sleep 30");
    Object.assign(hostPowerDeps, { helperDir: () => dir, writable: () => false });
    const child = spawnCli("/bin/true", [], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
    expect(child.pid).toBeGreaterThan(0);
    const closed = collect(child);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await forceCliTreeStopped(child);
    await closed;
    expect(hostPowerRefused(child)).toBe(false);
  });

  it("bwrapEngineStarted: only an exit-code record from bwrap's status fd is the sign the engine ran", () => {
    expect(bwrapEngineStarted('{ "child-pid": 41, "cgroup-namespace": 4026531835, "ipc-namespace": 4026531839 }\n{ "exit-code": 0 }\n')).toBe(true);
    expect(bwrapEngineStarted('{ "child-pid": 41 }\n{ "exit-code": 137 }\n')).toBe(true);
    expect(bwrapEngineStarted("")).toBe(false);
    expect(bwrapEngineStarted('{ "child-pid": 41 }\n')).toBe(false);
    expect(bwrapEngineStarted('{ "exit-code": "0" }\n')).toBe(false);
    expect(bwrapEngineStarted('{ "exit-code": 0 ')).toBe(false);
    expect(bwrapEngineStarted("exit-code 0\n")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("no marker, a cloud launch, and the docker server tool are not wrapped", async () => {
    Object.assign(hostPowerDeps, { helperDir: () => null, sandboxExec: "/nonexistent/sandbox-exec" });
    const plain = spawnCli("/bin/sh", ["-c", "exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
    expect((await collect(plain)).code).toBe(0);
    const marker = join(scratch(), cloud.marker);
    writeFileSync(marker, "#!/bin/sh\nexit 0\n"); chmodSync(marker, 0o755);
    const cloudChild = spawnCli(marker, [], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
    expect(cloudChild.pid).toBeGreaterThan(0);
    await collect(cloudChild);
    expect(hostPowerRefused(cloudChild)).toBe(false);
    const docker = spawnCli("docker", ["--version"], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true }, { serverTool: "docker" });
    const dockerResult = await collect(docker);
    expect(dockerResult.errors.map((error) => error.code)).not.toContain(HOST_POWER_CODE);
  });

  it.skipIf(process.platform !== "darwin")("macOS: sandbox-exec runs true, a shell redirection and node writing a byte; the logind lookup is denied", async () => {
    for (const [cli, args] of [["/usr/bin/true", []], ["/bin/sh", ["-c", "echo ok >/dev/null"]], [process.execPath, ["-e", "process.stdout.write('x')"]]] as const) {
      const child = spawnCli(cli, [...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, { hostPower: true });
      expect((await collect(child)).code).toBe(0);
    }
    // launchctl print of the logind service needs its bootstrap lookup; under the profile it is denied, without it it is not.
    const probe = spawnCli("/usr/bin/python3", ["-c", "import ctypes,sys;l=ctypes.CDLL('/usr/lib/libSystem.B.dylib');p=ctypes.c_uint(0);bp=ctypes.c_uint.in_dll(l,'bootstrap_port');sys.exit(0 if l.bootstrap_look_up(bp,b'com.apple.logind',ctypes.byref(p))!=0 else 3)"], { stdio: ["pipe", "pipe", "pipe"] }, { hostPower: true });
    const probed = await collect(probe);
    if (!/No such file|not found/.test(probed.err)) expect(probed.code).toBe(0);
  });
});

describe("Windows privilege removal (section 6)", () => {
  afterEach(() => { resetShutdownDropForTests(); addonState.addon = undefined; });
  const withAddon = (addon: unknown) => { addonState.addon = addon; };

  it("a token that still holds either privilege is a failed drop, a token that lacks both is success, a missing addon is a failure", () => {
    resetShutdownDropForTests();
    withAddon({ dropShutdownPrivileges: () => ({ ok: false, step: "verify", error: 0 }) });
    expect(dropServerShutdownPrivileges()).toEqual({ ok: false, reason: expect.stringContaining("verify") });
    resetShutdownDropForTests();
    withAddon({ dropShutdownPrivileges: () => ({ ok: true }) });
    expect(dropServerShutdownPrivileges()).toEqual({ ok: true });
    resetShutdownDropForTests();
    withAddon(null);
    expect(dropServerShutdownPrivileges().ok).toBe(false);
    resetShutdownDropForTests();
    withAddon({ dropShutdownPrivileges: () => ({ ok: "yes" }) });
    expect(dropServerShutdownPrivileges().ok).toBe(false); // only ok === true counts
  });

  it("the drop runs once: a later call returns the first answer without asking the addon again", () => {
    resetShutdownDropForTests();
    const drop = vi.fn(() => ({ ok: true }));
    withAddon({ dropShutdownPrivileges: drop });
    dropServerShutdownPrivileges(); dropServerShutdownPrivileges();
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it("procs.ts runs the drop at load on win32, before any engine spawn, and refuses a wrapped Windows launch with EPOWER before any job", () => {
    const procs = source("procs.ts");
    expect(procs).toContain('if (process.platform === "win32") dropServerShutdownPrivileges();');
    const refuse = procs.indexOf("dropServerShutdownPrivileges().ok !== true");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(procs.indexOf("pipJob = createPipJob("));
    // The job flags are unchanged and no UI-limited job is made.
    const native = readFileSync(new URL("../native/engine-exclusion/exclusion.c", import.meta.url), "utf8");
    expect(native).not.toContain("JOB_OBJECT_UILIMIT_EXITWINDOWS");
  });

  it("simulated Windows: a failed drop refuses the engine launch (no pid, EPOWER, the sentence); non-engine spawns are not refused", async () => {
    resetShutdownDropForTests();
    withAddon({ dropShutdownPrivileges: () => ({ ok: false, step: "adjust", error: 5 }) });
    const child = asPlatform("win32", () => spawnCli(process.execPath, ["-e", ""], { stdio: ["pipe", "pipe", "pipe"] }, { name: "Local\\murage-pip-eng-test", hostPower: true }));
    expect(child.pid).toBeUndefined();
    const errors: NodeJS.ErrnoException[] = [];
    child.on("error", (error) => errors.push(error));
    await new Promise((resolve) => child.on("close", resolve));
    expect(errors.map((error) => [error.code, error.message])).toEqual([[HOST_POWER_CODE, HOST_POWER_MESSAGE]]);
    expect(hostPowerRefused(child)).toBe(true);
  });
});

describe("the sentence (section 8)", () => {
  it("passes the copy rules, does not name log off, and gives the owner a next step on each system", () => {
    expect(HOST_POWER_MESSAGE_LINUX_MAC).toBe("Murage could not block shut down and restart for this engine, so this turn was not started. You can choose Claude, Codex or Fuigo as this bot's engine now, or update or reinstall Murage and try again.");
    expect(HOST_POWER_MESSAGE_WINDOWS).toBe("Murage could not block shut down and restart for this engine, so this turn was not started. Update or reinstall Murage, then try again.");
    expect(HOST_POWER_MESSAGE).toBe(process.platform === "win32" ? HOST_POWER_MESSAGE_WINDOWS : HOST_POWER_MESSAGE_LINUX_MAC);
    for (const message of [HOST_POWER_MESSAGE_LINUX_MAC, HOST_POWER_MESSAGE_WINDOWS]) {
      expect(message).not.toMatch(/—|–|log ?off|safe|unsafe|safety|Composio|price|\$|free/i);
    }
  });
});

describe("the real bwrap fixture (section 10)", () => {
  const cage = join(new URL("..", import.meta.url).pathname, "dist-native", "cage", `linux-${process.arch}`);
  const shipped = process.platform === "linux" && ["bwrap", "murage-power.bpf", "manifest.json"].every((name) => existsSync(join(cage, name)));
  const required = process.env.MURAGE_TEST_REQUIRE_HOST_POWER_CAGE === "1";
  // The server refuses to run as root (planHostPower), so a root test process cannot exercise the cage at all.
  const root = typeof process.geteuid === "function" && process.geteuid() === 0;
  beforeAll(() => {
    if (required) { expect(shipped, "the native cage must be built").toBe(true); expect(root, "the cage requires a non-root user").toBe(false); }
  });
  /** Outside required CI, a built cage may skip when the kernel denies this user a user namespace (EPERM). */
  const USERNS_EPERM = /^bwrap: (No permissions to create a new namespace|Creating new namespace failed: Operation not permitted|setting up uid map: (Operation not permitted|Permission denied)|unshare user ns: Operation not permitted)/;
  for (const ending of ["engine exit", "Stop", "engine-first, wrapper lingering", "wrapper-first", "forced Stop"] as const) {
    it.skipIf(!shipped || root)(`${ending} confirms the real cage only after descendants with closed stdio have ended`, async (context) => {
      await startHostPowerStub();
      const installed = scratch("murage-cage-lifecycle-");
      for (const name of ["bwrap", "murage-power.bpf", "manifest.json"]) {
        copyFileSync(join(cage, name), join(installed, name));
        chmodSync(join(installed, name), name === "bwrap" ? 0o555 : 0o444);
      }
      Object.assign(hostPowerDeps, { helperDir: () => installed });
      const work = scratch();
      const cleanup = join(work, "engine-cleanup");
      const ready = join(work, "descendant-ready");
      const pipedReady = join(work, "piped-descendant-ready");
      // The detached descendant holds no pipes. Confirmation must observe its
      // namespace ending, not infer that from stdout closing.
      const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`;
      const pipedDescendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pipedReady)},'ready');setInterval(()=>{},1000)`;
      const script = `
        const {spawn}=require('node:child_process');
        process.on('SIGTERM',()=>setTimeout(()=>{
          require('node:fs').writeFileSync(${JSON.stringify(cleanup)},'engine flushed');
          process.exit(0);
        },150));
        spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'}).unref();
        spawn(process.execPath,['-e',${JSON.stringify(pipedDescendant)}],{detached:true,stdio:['ignore','inherit','inherit']}).unref();
        process.stdin.on('data',()=>process.exit(0));
      `;
      const child = spawnCli(process.execPath, ["-e", script], { cwd: work, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1" } }, { hostPower: true });
      let err = "", closes = 0;
      child.on("error", () => {});
      child.stdout.resume();
      child.stderr.on("data", bytes => { err += bytes; });
      child.on("close", () => { closes++; });
      // Only follow this owned wrapper's children in the host /proc. A PID
      // printed by the engine belongs to its namespace and is not signalable here.
      const stat = (pid: number): { start: string; state: string } | null => {
        try {
          const text = readFileSync(`/proc/${pid}/stat`, "utf8");
          const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
          return { start: fields[19], state: fields[0] };
        } catch (error) {
          if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
          throw error;
        }
      };
      const snapshot = (pid: number): Array<{ pid: number; start: string }> => {
        const children = new Set(readdirSync(`/proc/${pid}/task`).flatMap(task =>
          readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)));
        return [...children].flatMap(pid => [{ pid, start: stat(pid)!.start }, ...snapshot(pid)]);
      };
      try {
        await expect.poll(() => (existsSync(ready) && existsSync(pipedReady)) || closes > 0, { timeout: 10_000 }).toBe(true);
        if (closes && hostPowerRefused(child) && USERNS_EPERM.test(err)) { context.skip(); return; }
        expect(closes, err).toBe(0);
        expect(hostPowerRefused(child), err).toBe(false);
        const members = snapshot(child.pid!);
        expect(members.length).toBeGreaterThanOrEqual(4); // namespace init, engine, detached descendants with and without pipes
        const engine = engineProcessPid(child)!;
        expect(members.map(member => member.pid)).toContain(engine);
        const gone = ({ pid, start }: { pid: number; start: string }) => {
          const current = stat(pid);
          return !current || current.start !== start || ["Z", "X"].includes(current.state);
        };
        // Assert inside the confirmation continuation, with no extra grace or
        // polling after it. The engine itself is the only writer of cleanup.
        const confirmed = cliTreeStoppedSignal(child).then(() => {
          expect(members.every(gone)).toBe(true);
          expect(closes).toBe(1);
          if (ending === "Stop" || ending === "engine-first, wrapper lingering") {
            expect(readFileSync(cleanup, "utf8")).toBe("engine flushed");
          }
        });
        if (ending === "engine exit") child.stdin.write("finish\n");
        else if (ending === "wrapper-first") {
          // Hold the engine alive, then terminate its wrapper first. Namespace
          // teardown must still end the stopped engine and its pipe-less child.
          process.kill(engine, "SIGSTOP");
          killCliTree(child);
          child.kill("SIGTERM");
        } else if (ending === "forced Stop") expect(await forceCliTreeStopped(child)).toBe(true);
        else {
          if (ending === "engine-first, wrapper lingering") process.kill(child.pid!, "SIGSTOP");
          killCliTree(child);
          if (ending === "engine-first, wrapper lingering") {
            await expect.poll(() => existsSync(cleanup) && gone(members.find(member => member.pid === engine)!), { timeout: 2_000 }).toBe(true);
            expect(closes).toBe(0);
            expect(cliTreeConfirmedStopped(child)).toBe(false);
          }
        }
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([confirmed, new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("cage stop confirmation timed out")), 10_000);
          })]);
        } finally { clearTimeout(deadline); }
        expect(await awaitCliTreeStopped(child)).toBe(true);
        expect(cliTreeConfirmedStopped(child)).toBe(true);
        expect(hostPowerRefused(child)).toBe(false);
        // A repeated Stop joins the same ended handle and emits no extra close.
        expect(await forceCliTreeStopped(child)).toBe(true);
        expect(closes).toBe(1);
      } finally { await forceCliTreeStopped(child); }
    }, 30_000);
  }

  it("reuses the caged ACP engine on turn two after an MCP restart, and rejects a matching-argv child of another MCP process", async (context) => {
    if (!shipped || root) {
      console.info(`real-cage ACP reuse skipped: ${!shipped ? "shipped Linux cage is absent" : "host-power refuses a root test process"}`);
      context.skip(); return;
    }
    await startHostPowerStub();
    // The same shipped artifacts and install permissions as the lifecycle tests above.
    const installed = scratch("murage-cage-acp-reuse-");
    for (const name of ["bwrap", "murage-power.bpf", "manifest.json"]) {
      copyFileSync(join(cage, name), join(installed, name));
      chmodSync(join(installed, name), name === "bwrap" ? 0o555 : 0o444);
    }
    Object.assign(hostPowerDeps, { helperDir: () => installed });
    const [{ ensureDirs }, { createAcpDriver, resetAcpMcpReadinessForTests }, { recordEvents }, { warmPool }, procs] = await Promise.all([
      import("./config.ts"), import("./drivers/acp/core.ts"), import("./testing/events.ts"), import("./drivers/warm-pool.ts"), import("./procs.ts"),
    ]);
    ensureDirs(); // server/testing/setup.ts supplies the isolated home and data directory.
    const work = scratch("murage-caged-acp-");
    const fakeCli = fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url));
    const spawnLog = join(work, "spawns.log"), rpcLog = join(work, "rpc.log"), mcpLog = join(work, "mcp.log");
    const readyGate = join(work, "release-mcp-ready"), nestedGate = join(work, "start-nested"), nestedPid = join(work, "nested.pid");
    const mcpScript = join(work, "mcp.cjs");
    writeFileSync(mcpScript, `
      const {existsSync, writeFileSync} = require('node:fs');
      if (process.env.MURAGE_FIXTURE_NESTED === '1') {
        writeFileSync(${JSON.stringify(nestedPid)}, String(process.pid));
      } else if (existsSync(${JSON.stringify(nestedGate)})) {
        require('node:child_process').spawn(process.execPath, [__filename], {
          env: {...process.env, MURAGE_FIXTURE_NESTED: '1'}, stdio: 'ignore'
        });
      }
      setInterval(() => {}, 1000);
    `);
    const env = {
      MURAGE_ACP_POOL: "1", MURAGE_ACP_CROSS_THREAD_SPARE: "0", MURAGE_ACP_MCP_READY_MS: "20000",
      FAKE_ACP_SPAWN_LOG: spawnLog, FAKE_ACP_RPC_LOG: rpcLog, FAKE_ACP_MCP_CHILD_LOG: mcpLog,
      FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_GATE_FILE: readyGate,
    };
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const driver = createAcpDriver({
      driverKind: "cagedPoolTest", displayName: "Caged Pool Test",
      models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
      defaultCli: process.execPath, nativeSource: "caged-pool.acp", loginNote: "never reached",
      spawnArgs: () => [fakeCli], pickAuthMethod: methods => methods[0]?.id ?? null,
      authFailure: "continue", isAuthenticated: () => true,
      mcpReadyNotification: "_fuigo/mcp_initialized", pooledSessions: true,
    });
    const wrappers: Array<ReturnType<typeof spawnCli>> = [];
    const stderr: string[] = [], info: string[] = [];
    const realSpawn = procs.spawnCli;
    // Observe handles without replacing the real spawn, wrapper, PID resolution or tree probes.
    const spawnSpy = vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
      const child = realSpawn(...args);
      if (args[0] === process.execPath && args[1][0] === fakeCli) {
        const index = wrappers.push(child) - 1;
        stderr[index] = "";
        child.stderr.on("data", bytes => { stderr[index] += String(bytes); });
      }
      return child;
    });
    const infoSpy = vi.spyOn(console, "info").mockImplementation((...args) => { info.push(args.map(String).join(" ")); });
    const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    const calls = (method: string) => lines(rpcLog).map(line => JSON.parse(line) as { pid: number; method: string; noReplay?: true }).filter(row => row.method === method);
    const stat = (pid: number) => {
      try {
        const text = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
        return { pid, ppid: Number(fields[1]), start: fields[19], state: fields[0] };
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
        throw error;
      }
    };
    type Member = NonNullable<ReturnType<typeof stat>>;
    const observed = new Map<number, Member>();
    // Logs inside bwrap contain namespace PIDs. Resolve them only within this owned wrapper's host tree.
    const snapshot = (pid: number): Member[] => {
      try {
        const children = new Set(readdirSync(`/proc/${pid}/task`).flatMap(task =>
          readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)));
        return [...children].flatMap(pid => {
          const member = stat(pid);
          if (!member) return [];
          observed.set(pid, member);
          return [member, ...snapshot(pid)];
        });
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
        throw error;
      }
    };
    const memberFor = (namespacePid: number) => snapshot(wrappers[0].pid!).find(member => {
      try {
        const pids = /^NSpid:\s+(.+)$/m.exec(readFileSync(`/proc/${member.pid}/status`, "utf8"))?.[1].trim().split(/\s+/).map(Number);
        return pids?.at(-1) === namespacePid;
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
      }
    });
    const gone = (member: Member) => {
      const current = stat(member.pid);
      return !current || current.start !== member.start || ["Z", "X"].includes(current.state);
    };
    let instance: Awaited<ReturnType<typeof driver.create>> | undefined;
    let recorder: ReturnType<typeof recordEvents> | undefined;
    try {
      instance = await driver.create({ instanceId: "caged-pool", displayName: "Caged Pool Test", environment: {}, enabled: true, config: { cli: process.execPath, fullAuto: false } });
      recorder = recordEvents(instance.adapter);
      let engine: Member | undefined, previousMcp: Member | undefined;
      for (const turn of [1, 2, 3]) {
        if (turn > 1) unlinkSync(readyGate);
        if (turn === 3) writeFileSync(nestedGate, "start");
        const { turnId } = await instance.adapter.sendTurn({
          threadId: "t-caged-pool", text: `turn ${turn}`, cwd: work,
          ...(turn > 1 ? { resumeCursor: "fake-acp-session" } : {}),
          // Change only the server contract, so session/load restarts MCP on the warm engine.
          integrations: { agents: { command: process.execPath, args: [mcpScript], env: { MURAGE_FIXTURE_TURN: String(turn) } } },
        });
        await expect.poll(() => lines(mcpLog).length >= turn || recorder!.events.some(event => event.type === "turn.completed" && event.turnId === turnId), { timeout: 10_000 }).toBe(true);
        const wrapper = wrappers[0];
        if (turn === 1 && wrapper && hostPowerRefused(wrapper) && USERNS_EPERM.test(stderr[0])) {
          console.warn("real-cage ACP reuse skipped: kernel denies this user's user namespace");
          context.skip(); return;
        }
        expect(wrappers).toHaveLength(1); // includes turn two before reconciliation: no cold acquisition
        expect(spawnSpy.mock.calls.find(args => args[1][0] === fakeCli)?.[3]).toEqual({ hostPower: true });
        expect(hostPowerRefused(wrapper), stderr[0]).toBe(false);
        expect(readFileSync(`/proc/${wrapper.pid}/cmdline`, "utf8").split("\0")[0]).toBe(join(installed, "bwrap"));
        expect(lines(mcpLog)).toHaveLength(turn);
        const currentEngine = stat(engineProcessPid(wrapper)!);
        expect(currentEngine).not.toBeNull();
        expect(currentEngine!.pid).not.toBe(wrapper.pid);
        if (!engine) engine = currentEngine!;
        expect(currentEngine).toMatchObject({ pid: engine.pid, start: engine.start });
        expect(memberFor(Number(lines(spawnLog)[0]))).toMatchObject({ pid: engine.pid, start: engine.start });
        const mcpNamespacePid = Number(lines(mcpLog).at(-1));
        await expect.poll(() => memberFor(mcpNamespacePid), { timeout: 5_000 }).toBeDefined();
        const mcp = memberFor(mcpNamespacePid)!;
        expect(mcp.ppid).toBe(engine.pid);
        expect(mcp.ppid).not.toBe(wrapper.pid);
        if (previousMcp) {
          expect(mcp.pid).not.toBe(previousMcp.pid);
          await expect.poll(() => gone(previousMcp!), { timeout: 5_000 }).toBe(true);
        }
        if (turn === 3) {
          await expect.poll(() => lines(nestedPid).length, { timeout: 5_000 }).toBe(1);
          const nested = memberFor(Number(lines(nestedPid)[0]))!;
          expect(nested).toBeDefined();
          expect(nested.ppid).toBe(mcp.pid);
          expect(nested.ppid).not.toBe(engine.pid);
          // Both argv strings match the handed server exactly. Only parentage disqualifies the nested child.
          for (const member of [mcp, nested]) expect(readFileSync(`/proc/${member.pid}/cmdline`, "utf8").replace(/\0/g, " ").trim()).toBe(`${process.execPath} ${mcpScript}`);
        }
        writeFileSync(readyGate, "ready");
        expect(await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId)).toMatchObject({ ok: true, stopReason: null });
        expect(calls("session/prompt")).toHaveLength(turn);
        if (turn < 3) {
          expect(wrappers).toHaveLength(1);
          expect(engineProcessPid(wrapper)).toBe(engine.pid);
          expect(lines(spawnLog)).toHaveLength(1);
          expect(calls("initialize")).toHaveLength(1);
          expect(calls("authenticate")).toHaveLength(1);
          expect(calls("session/new")).toHaveLength(1);
          expect(calls("session/load")).toHaveLength(turn - 1);
          if (turn === 2) expect(calls("session/load")[0]).toMatchObject({ noReplay: true });
          expect(info.some(line => /reason=(pre-prompt-leftover|post-turn-descendant)/.test(line))).toBe(false);
          expect(warmPool.idleCount()).toBe(1);
        } else {
          // The pool.test.ts observable: the same turn closes the leftover tree and starts fresh.
          expect(info.some(line => line.includes("acp close thread=t-caged-pool reason=pre-prompt-leftover"))).toBe(true);
          expect(wrappers).toHaveLength(2);
          expect(lines(spawnLog)).toHaveLength(2); // namespace PID 2 may occur twice; count actual launches
          expect(calls("initialize")).toHaveLength(2);
          expect(engineProcessPid(wrappers[1])).not.toBe(engine.pid);
          expect(await awaitCliTreeStopped(wrapper)).toBe(true);
          expect(gone(engine)).toBe(true);
        }
        previousMcp = mcp;
      }
    } finally {
      try { await instance?.dispose(); }
      finally {
        try {
          const stopped = await Promise.all(wrappers.map(wrapper => forceCliTreeStopped(wrapper)));
          expect(stopped.every(Boolean)).toBe(true);
          expect([...observed.values()].every(gone)).toBe(true);
        } finally {
          recorder?.stop();
          resetAcpMcpReadinessForTests();
          spawnSpy.mockRestore(); infoSpy.mockRestore(); vi.unstubAllEnvs();
        }
      }
    }
  }, 90_000);

  it.skipIf(!required && (!shipped || root))("reads its cwd, opens the minimal /dev, runs a redirection and node, receives the turn env, and cannot reach the system bus", async (context) => {
    await startHostPowerStub();
    // Keep the executable at the path covered by CI's AppArmor userns profile. Only the writable seam is replaced;
    // the real host architecture, manifest, executable bytes and production filter pin are checked normally.
    Object.assign(hostPowerDeps, { helperDir: () => realpathSync(cage), writable: () => false });
    const work = scratch();
    writeFileSync(join(work, "f.txt"), "hello");
    const script = [
      "cat f.txt >/dev/null", "echo ok >/dev/null",
      "for n in null zero full random urandom tty ptmx pts; do [ -e /dev/$n ] || exit 11; done",
      "{ [ ! -e /dev/mem ] || exit 12; }",
      '{ [ "$MURAGE_POWER_TURN_VALUE" = "turn value 1" ] || exit 15; }',
      `"${process.execPath}" -e "process.stdout.write('x')"`,
      // the system bus path, when the host has one, is the stub inside: the connection is closed at once
      `{ [ ! -S /run/dbus/system_bus_socket ] || "${process.execPath}" -e "const s=require('net').createConnection('/run/dbus/system_bus_socket');s.on('data',()=>process.exit(13));s.on('error',()=>process.exit(0));s.on('close',()=>process.exit(0));setTimeout(()=>process.exit(14),3000)"; }`,
    ].join(" && ");
    const child = spawnCli("/bin/sh", ["-c", script], { cwd: work, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: "1", MURAGE_POWER_TURN_VALUE: "turn value 1" } }, { hostPower: true });
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      let out = "", err = "";
      child.on("error", () => {});
      child.stdout.on("data", (c) => { out += c; }); child.stderr.on("data", (c) => { err += c; });
      child.on("close", (code) => resolve({ code, out, err }));
    });
    // Required CI treats every refusal as a failure; other hosts may lack user namespace permission.
    if (!required && hostPowerRefused(child) && child.pid !== undefined && USERNS_EPERM.test(result.err)) { context.skip(); return; }
    expect({ refused: hostPowerRefused(child), err: result.err }).toEqual({ refused: false, err: "" });
    expect(result.code).toBe(0);
    expect(result.out).toBe("x");
  });

  it.skipIf(!required && (!shipped || root))("the real bwrap: an engine that cannot be exec'd reads as the refusal; one that ran and failed does not", async (context) => {
    await startHostPowerStub();
    // Keep the executable at the path covered by CI's AppArmor userns profile. Only the writable seam is replaced;
    // the real host architecture, manifest, executable bytes and production filter pin are checked normally.
    Object.assign(hostPowerDeps, { helperDir: () => realpathSync(cage), writable: () => false });
    const run = (command: string, args: string[]) => {
      const child = spawnCli(command, args, { cwd: scratch(), stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } }, { hostPower: true });
      return new Promise<{ child: typeof child; code: number | null; err: string }>((resolve) => {
        let err = "";
        child.on("error", () => {});
        child.stdout.on("data", () => {}); child.stderr.on("data", (c) => { err += c; });
        child.on("close", (code) => resolve({ child, code, err }));
        try { child.stdin.end(); } catch { /* closed */ }
      });
    };
    const ran = await run("/bin/sh", ["-c", "exit 3"]);
    if (!required && hostPowerRefused(ran.child) && USERNS_EPERM.test(ran.err)) { context.skip(); return; }
    expect({ code: ran.code, refused: hostPowerRefused(ran.child), err: ran.err }).toEqual({ code: 3, refused: false, err: "" });
    const missing = await run("/nonexistent/murage-engine", []);
    expect(missing.err).toMatch(/^bwrap: execvp \/nonexistent\/murage-engine/);
    expect(hostPowerRefused(missing.child)).toBe(true);
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a witnesses (designs/1021-m2-w0/DESIGN-r5.md F1/F2/F3, r5.1 G2/G3, r5.2 H1, r5.3 I2):
// T-S1A-NO-SWITCH, the mode-decision order, the G2 claim-capture placement, and T-S1A-COORD-BOOT on a
// real server child with a module-load and spawn trace (plus the HOSTED-branch positive control).
// Owner: O1 m2 S1a builder lane (fix/1022-o1m2). Every server child here uses a temporary HOME.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { decideFuigoBootMode, decideFuigoBootModeNow, HOSTED_QUALIFIED } from "./hosted-mode.ts";
import { hostedClaimRefused, markHostedGeneration, retireHostedGeneration } from "./hosted-generations.ts";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";
import { childEnv } from "../testing/murage-env.mjs";
import { OPTIONAL_INDEXES } from "../memory/optional-index.ts";
import "../memory/schema.ts";

const HOST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HOST_DIR, "..");
const ROOT = join(SERVER_DIR, "..");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const isTestFile = (rel: string) => /\.(test|node-test)\.(ts|mts|mjs|js)$/.test(rel);
/** Fable N1: the one named preload, plus the definition and the forwarder's construction tie. */
const OVERRIDE_ALLOW = new Set(["server/host/hosted-mode.ts", "server/host/hosted-forwarder.ts", "server/testing/hosted-override-preload.mjs"]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".") || name === "dist" || name === "dist-server" || name === "target") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(ts|mts|mjs|js|cjs)$/.test(name)) out.push(relative(ROOT, full).split(sep).join("/"));
    }
  };
  for (const top of ["server", "shared", "electron", "scripts", "src", "apps", "installer", "companion", "tools"]) if (existsSync(join(ROOT, top))) walk(join(ROOT, top));
  return out;
}
/** Build and packaging configuration that could name a preload or pass an argument to the shipped server. */
const configFiles = () => readdirSync(ROOT).filter(name => name === "package.json" || /^electron-builder.*\.ya?ml$/.test(name) || /^tsconfig.*\.json$/.test(name));

describe("T-S1A-NO-SWITCH (static)", () => {
  it("ships every HOSTED_QUALIFIED entry false and frozen", () => {
    expect(Object.isFrozen(HOSTED_QUALIFIED)).toBe(true);
    expect(Object.values(HOSTED_QUALIFIED).every(value => value === false), JSON.stringify(HOSTED_QUALIFIED)).toBe(true);
  });

  it("references the override only at its definition, the one named preload and test files", () => {
    const scanned = [...sourceFiles(), ...configFiles()];
    expect(scanned).toContain("package.json");
    const offenders = scanned.filter(rel => !OVERRIDE_ALLOW.has(rel) && !isTestFile(rel))
      .filter(rel => /hostedQualifiedOverride|armHostedOverrideForTest|hosted-override-preload/.test(read(rel)));
    expect(offenders).toEqual([]);
  });

  // Opus M4: per-file token rule. Only the one named preload calls the arm; the definition file only defines it.
  it("only the named preload calls armHostedOverrideForTest", () => {
    const callers = sourceFiles().filter(rel => !isTestFile(rel)).filter(rel => /armHostedOverrideForTest\s*\(/.test(read(rel).replace(/export function armHostedOverrideForTest\s*\(/, "")));
    expect(callers).toEqual(["server/testing/hosted-override-preload.mjs"]);
  });

  // Opus M3 / Fable N1: the preload never reaches a shipped bundle. The server build excludes server/testing, and no
  // bundle entry, builder file or package script names the preload or a server/testing module.
  it("keeps the preload out of every shipped bundle", () => {
    const build = JSON.parse(read("tsconfig.server.build.json")) as { exclude?: string[] };
    expect(build.exclude ?? []).toContain("server/testing");
    const entries = read("scripts/bundle-server.mjs").match(/const ENTRY_POINTS = \[([\s\S]*?)\];/)?.[1] ?? "";
    expect(entries.length).toBeGreaterThan(0);
    expect(entries).not.toMatch(/testing\/|hosted-override-preload|host\/hosted-forwarder/);
    expect(entries).toContain('"host/host-main.ts"');
    for (const rel of configFiles()) expect(read(rel), rel).not.toMatch(/hosted-override-preload|server\/testing\/hosted/);
  });

  // Opus M2: the decision module has no value import, so it cannot reach env, fs or a database through a helper.
  it("the mode-decision module has no value imports", () => {
    const imports = read("server/host/hosted-mode.ts").split("\n").filter(line => /^\s*import\b/.test(line));
    expect(imports.filter(line => !/^\s*import\s+type\b/.test(line))).toEqual([]);
    expect(read("server/host/hosted-mode.ts")).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });

  it("the mode-decision module reads no environment, argv, settings, file or database", () => {
    const code = read("server/host/hosted-mode.ts").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code.match(/process\.env|process\.argv|node:fs|from "fs"|loadConfig|database|readFile|getenv/g) ?? []).toEqual([]);
  });

  it("never loads the forwarder or host statically from production code, and S1a host modules carry no DDL", () => {
    const index = read("server/index.ts");
    expect(index).not.toMatch(/^import[^;]*["']\.\/host\/hosted-forwarder\.ts["']/m);
    expect(read("server/drivers/builtIn.ts")).not.toMatch(/host\//);
    for (const rel of sourceFiles().filter(file => file.startsWith("server/host/") && !isTestFile(file))) {
      expect(read(rel), rel).not.toMatch(/CREATE\s+(TABLE|INDEX|TRIGGER|VIEW)|ALTER\s+TABLE|from ["']\.\.\/database\.ts["']/i);
    }
  });

  // r5.2 H1 / r5.3 I2 (M42): construction outside both test runners throws, even with the override passed explicitly.
  const runForwarder = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(pathToFileURL(join(HOST_DIR, "hosted-forwarder.ts")).href)});
     try { new m.HostedFuigoForwarder({ hostedQualifiedOverride: true }); console.log("constructed"); }
     catch (error) { console.log("refused:" + error.message); }`], { env, encoding: "utf8", timeout: 30_000 });
  const noRunnerEnv = () => { const env = { ...process.env }; delete env.VITEST; delete env.NODE_TEST_CONTEXT; return env; };

  it("refuses forwarder construction in a child with no test runner, override passed explicitly", () => {
    const outside = runForwarder(noRunnerEnv());
    expect(outside.stdout.trim(), outside.stderr).toBe("refused:HOSTED_UNQUALIFIED_BUILD");
    const control = runForwarder({ ...noRunnerEnv(), VITEST: "true" });
    expect(control.stdout.trim(), control.stderr).toBe("constructed");
  });

  it("the named preload refuses outside a test runner", () => {
    const run = spawnSync(process.execPath, ["--import", pathToFileURL(join(SERVER_DIR, "testing", "hosted-override-preload.mjs")).href, "-e", "console.log('ran')"],
      { env: noRunnerEnv(), encoding: "utf8", timeout: 30_000 });
    expect(run.stdout).not.toContain("ran");
    expect(run.stderr).toContain("HOSTED_UNQUALIFIED_BUILD");
  });
});

describe("mode decision order (F1, M32)", () => {
  it("returns COORDINATOR on condition (3) before any probe runs", async () => {
    const hostHello = vi.fn(async () => ({ ok: true, dumpsDisabled: true }));
    const coordinatorDumpsDisabled = vi.fn(() => true);
    for (const platform of ["linux", "darwin"] as const) {
      expect(await decideFuigoBootMode({ platform, probes: { hostHello, coordinatorDumpsDisabled } })).toEqual({ mode: "COORDINATOR", reason: "hosted_unqualified" });
    }
    expect(await decideFuigoBootMode({ platform: "win32", probes: { hostHello, coordinatorDumpsDisabled } })).toEqual({ mode: "COORDINATOR", reason: "dump_policy_unavailable" });
    expect(hostHello).not.toHaveBeenCalled();
    expect(coordinatorDumpsDisabled).not.toHaveBeenCalled();
  });

  it("on a qualified OS runs hello before the coordinator's own dump policy, and any false condition stays COORDINATOR", async () => {
    const order: string[] = [];
    const probes = { hostHello: async () => { order.push("hello"); return { ok: true, dumpsDisabled: true }; }, coordinatorDumpsDisabled: () => { order.push("dumps"); return true; } };
    const table = { linux: true, darwin: false, win32: false } as const;
    expect(await decideFuigoBootMode({ platform: "linux", qualifiedTable: table, probes })).toEqual({ mode: "HOSTED", reason: "hosted_ready" });
    expect(order).toEqual(["hello", "dumps"]);
    expect(await decideFuigoBootMode({ platform: "linux", qualifiedTable: table, probes: { ...probes, hostHello: async () => ({ ok: false, dumpsDisabled: true }) } })).toEqual({ mode: "COORDINATOR", reason: "host_no_hello" });
    expect(await decideFuigoBootMode({ platform: "linux", qualifiedTable: table })).toEqual({ mode: "COORDINATOR", reason: "host_no_hello" });
    expect(decideFuigoBootModeNow({ platform: "win32", qualifiedTable: { linux: true, darwin: true, win32: true } })).toEqual({ mode: "COORDINATOR", reason: "dump_policy_unavailable" });
  });
});

describe("G2 claim-capture refusal (F2 as moved by r5.1 G2)", () => {
  it("refuses a live claim of a hosted generation until its retire, and never a null claim", () => {
    expect(hostedClaimRefused(null)).toBe(false);
    expect(hostedClaimRefused({ generation: "g-hosted" })).toBe(false);
    markHostedGeneration("g-hosted");
    expect(hostedClaimRefused({ generation: "g-hosted" })).toBe(true);
    expect(hostedClaimRefused({ generation: "g-coordinator" })).toBe(false);
    retireHostedGeneration("g-hosted");
    expect(hostedClaimRefused({ generation: "g-hosted" })).toBe(false);
  });

  // G2 retire side (r5 NEXT 3, SITES-G2.md in the lane dir): every InternalCapabilities revoke path funnels through
  // revokeGeneration (or revokeAll); each row drives one production path on a real InternalCapabilities with the real
  // producer (HostedFuigoForwarder.beginTurn) and asserts the hosted generation leaves the refusal set exactly when its
  // last token retired, never earlier (live sibling thread, same generation id) and never for an unrelated generation.
  describe("retire on capability revocation (every revoke path)", () => {
    type Caps = InstanceType<typeof import("../internal-capabilities.ts").InternalCapabilities>;
    const rows: ReadonlyArray<readonly [string, (caps: Caps) => void]> = [
      ["revokeGeneration", caps => caps.revokeGeneration("t-hosted", "g-hosted")],
      ["revokeThread", caps => caps.revokeThread("t-hosted")],
      ["revokeBot", caps => caps.revokeBot("b-hosted")],
      ["begin (next turn on the thread)", caps => { caps.begin("b-hosted", "t-hosted", "g-next"); }],
      ["completeProviderTurn", caps => { expect(caps.bindProviderTurn("t-hosted", "g-hosted", "turn-1")).toBe(true); caps.completeProviderTurn("t-hosted", "turn-1"); }],
      ["bindProviderTurn without a turn id", caps => { expect(caps.bindProviderTurn("t-hosted", "g-hosted", "")).toBe(false); }],
      ["revokeAll", caps => caps.revokeAll()],
    ];
    const mint = (caps: Caps, botId: string, threadId: string, generation: string) =>
      `Bearer ${caps.mint({ botId, threadId, generation, kind: "agents", depth: 0, skillAuthoring: false })}`;

    it.each(rows)("%s retires the hosted generation once its last token retired", async (_site, revoke) => {
      const { InternalCapabilities } = await import("../internal-capabilities.ts");
      const { HostedFuigoForwarder } = await import("./hosted-forwarder.ts");
      const { hostedGenerationCount } = await import("./hosted-generations.ts");
      const caps = new InternalCapabilities();
      const forwarder = new HostedFuigoForwarder({ hostedQualifiedOverride: true });
      caps.begin("b-hosted", "t-hosted", "g-hosted");
      caps.begin("b-coord", "t-coord", "g-coord");
      const hosted = mint(caps, "b-hosted", "t-hosted", "g-hosted");
      const coordinator = mint(caps, "b-coord", "t-coord", "g-coord");
      forwarder.beginTurn("g-hosted");
      expect(hostedClaimRefused(caps.resolve(hosted))).toBe(true);
      expect(hostedClaimRefused(caps.resolve(coordinator))).toBe(false);
      revoke(caps);
      expect(caps.resolve(hosted)).toBeNull();
      expect(hostedClaimRefused({ generation: "g-hosted" }), "hosted generation still in the refusal set after its last token retired").toBe(false);
      expect(hostedGenerationCount()).toBe(0);
      caps.revokeAll();
    });

    it("keeps a generation refused while a live token of the same id remains on another thread (fail-closed)", async () => {
      const { InternalCapabilities } = await import("../internal-capabilities.ts");
      const { HostedFuigoForwarder } = await import("./hosted-forwarder.ts");
      const caps = new InternalCapabilities();
      caps.begin("b-hosted", "t-hosted", "g-shared");
      caps.begin("b-other", "t-other", "g-shared");
      mint(caps, "b-hosted", "t-hosted", "g-shared");
      const sibling = mint(caps, "b-other", "t-other", "g-shared");
      new HostedFuigoForwarder({ hostedQualifiedOverride: true }).beginTurn("g-shared");
      caps.revokeGeneration("t-hosted", "g-shared");
      expect(hostedClaimRefused(caps.resolve(sibling)), "sibling live claim reopened by an early retire").toBe(true);
      caps.revokeGeneration("t-other", "g-shared");
      expect(hostedClaimRefused({ generation: "g-shared" })).toBe(false);
    });

    it("keeps a generation refused while only an owner (no token) of the same id remains on another thread", async () => {
      const { InternalCapabilities } = await import("../internal-capabilities.ts");
      const { HostedFuigoForwarder } = await import("./hosted-forwarder.ts");
      const caps = new InternalCapabilities();
      caps.begin("b-hosted", "t-hosted", "g-owner");
      caps.begin("b-other", "t-other", "g-owner");
      mint(caps, "b-hosted", "t-hosted", "g-owner");
      new HostedFuigoForwarder({ hostedQualifiedOverride: true }).beginTurn("g-owner");
      caps.revokeGeneration("t-hosted", "g-owner");
      expect(hostedClaimRefused({ generation: "g-owner" }), "retired while a live owner of the generation remained").toBe(true);
      caps.revokeAll();
      expect(hostedClaimRefused({ generation: "g-owner" })).toBe(false);
    });

    // Astra r7 High: a private registry (index.ts memory approval release, own-apply) shares the process-wide set.
    it("a private registry's revokeGeneration/revokeAll never reopens a live hosted claim of the claim-capture registry", async () => {
      const { InternalCapabilities } = await import("../internal-capabilities.ts");
      const { HostedFuigoForwarder } = await import("./hosted-forwarder.ts");
      const main = new InternalCapabilities();
      main.begin("b-hosted", "t-hosted", "g-live");
      const live = mint(main, "b-hosted", "t-hosted", "g-live");
      new HostedFuigoForwarder({ hostedQualifiedOverride: true }).beginTurn("g-live");
      for (const release of [(p: Caps) => p.revokeGeneration("t-hosted", "g-live"), (p: Caps) => p.revokeAll()]) {
        const priv = new InternalCapabilities();
        priv.begin("b-hosted", "t-hosted", "g-live");
        mint(priv, "b-hosted", "t-hosted", "g-live");
        release(priv);
        expect(hostedClaimRefused(main.resolve(live)), "private registry release reopened a live hosted claim").toBe(true);
      }
      main.revokeAll();
      expect(hostedClaimRefused({ generation: "g-live" })).toBe(false);
    });
  });

  it("sits on the claim-capture tick: after the claim resolves, before the binding lookup and before any await (M41)", () => {
    const lines = read("server/index.ts").split("\n");
    const at = (pattern: RegExp) => lines.findIndex(line => pattern.test(line));
    const claim = at(/^\s*const requestClaim = consumingRequest \? internalCapabilities\.resolve\(/);
    const guard = at(/^\s*if \(hostedClaimRefused\(requestClaim\)\) return denyConsumingHttp\(res\);/);
    const binding = at(/^\s*const requestBinding = requestClaim \?/);
    expect(claim).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(claim);
    expect(binding).toBeGreaterThan(guard);
    expect(lines.slice(at(/^\s*const consumingRequest = /), guard).filter(line => !/^\s*\/\//.test(line)).join("\n")).not.toMatch(/\bawait\b/);
  });
});

// T-S1A-COORD-BOOT (r5.1 G3, r5.3 I2): a real production-argument boot launches no host, never evaluates the forwarder or
// host modules, registers FuigoAgentDriver and creates no custody file. The HOSTED-branch arm is the positive control
// that the same trace does see the forwarder when the one named preload is present.
describe.skipIf(process.platform === "win32")("T-S1A-COORD-BOOT (real server child)", () => {
  const children: ChildProcess[] = [];
  const homes: string[] = [];
  afterAll(async () => {
    for (const child of children) await waitForExit(child, { signal: "SIGTERM" });
    for (const home of homes) await removeTempDir(home);
  });

  // retain-writer (D1.2): a preload in the real host keeps its copy of the engine's stdin writer open while still reporting the
  // handoff, and records whether that copy was open when it reported (the fixture's own control).
  const retainWriterPreload = (trace: string) => `
import { readdirSync, readlinkSync, writeFileSync } from "node:fs";
const send = process.send.bind(process);
const fdTarget = fd => { try { return readlinkSync("/proc/self/fd/" + fd); } catch { return null; } };
let socket;
process.send = function (frame, handle, ...rest) {
  if (frame?.type === "probe_spawned" && handle) {
    socket = fdTarget(handle._handle.fd);
    handle.destroy = function () { this.emit("close"); return this; };
  }
  if (frame?.type === "probe_handoff") writeFileSync(${JSON.stringify(trace + ".retained")}, JSON.stringify({ socket: String(socket).startsWith("socket:"), open: readdirSync("/proc/self/fd").some(fd => fdTarget(fd) === socket) }));
  return send(frame, handle, ...rest);
};
`;

  // withhold-handoff (D1.2 ruling): a preload in the real host drops its close report (probe_handoff) and records that it did.
  const withholdHandoffPreload = (trace: string) => `
import { writeFileSync } from "node:fs";
const send = process.send.bind(process);
process.send = function (frame, ...rest) {
  if (frame?.type === "probe_handoff") { writeFileSync(${JSON.stringify(trace + ".withheld")}, ""); return true; }
  return send(frame, ...rest);
};
`;

  type GateTrace = "gate" | "foreign-parent" | "retain-writer" | "withhold-handoff";
  const traceHook = (trace: string, traceGate?: GateTrace) => `
import { registerHooks, syncBuiltinESMExports } from "node:module";
import fs, { appendFileSync } from "node:fs";
import cp from "node:child_process";
const trace = ${JSON.stringify(trace)};
const gateTrace = ${JSON.stringify(traceGate ?? null)};
const processStat = pid => fs.readFileSync("/proc/" + pid + "/stat", "utf8").split(") ")[1].split(/\\s+/);
let hostPid;
registerHooks({ load(url, context, next) { if (url.includes("/server/host/")) appendFileSync(trace, "load " + url + "\\n"); return next(url, context); } });
if (gateTrace) {
  const fsync = fs.fsyncSync;
  fs.fsyncSync = function (fd) {
    fsync(fd);
    const path = fs.readlinkSync("/proc/self/fd/" + fd);
    if (path.endsWith("/hosted-custody.jsonl")) {
      const records = fs.readFileSync(path, "utf8").trim().split("\\n").map(line => JSON.parse(line));
      const record = records.at(-1);
      if (record.role === "engine") {
        const host = records.find(entry => entry.role === "host");
        const stat = processStat(record.pid);
        fs.writeFileSync(trace + ".custody", JSON.stringify({
          actual: record,
          expected: { boot_id: host.boot_id, kboot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
            inc: host.inc, role: "engine", pid: record.pid, start: stat[19], pgid: Number(stat[2]) },
          directChild: Number(stat[1]) === hostPid && Number(stat[2]) === record.pid,
        }));
        appendFileSync(trace, "gate sync " + record.pid + "\\n");
      }
    }
  };
}
for (const name of ["spawn", "spawnSync", "fork", "execFile", "execFileSync", "exec", "execSync"]) {
  const original = cp[name];
  cp[name] = function (...args) {
    appendFileSync(trace, "spawn " + JSON.stringify([args[0], Array.isArray(args[1]) ? args[1] : []]) + "\\n");
    const launchesHost = name === "spawn" && args[1]?.some(arg => /host-main\\.[tj]s$/.test(arg));
    if ((gateTrace === "retain-writer" || gateTrace === "withhold-handoff") && launchesHost) {
      const env = args[2].env;
      args[2] = { ...args[2], env: { ...env, NODE_OPTIONS: ((env.NODE_OPTIONS ?? "") + " --import=" + ${JSON.stringify(pathToFileURL(trace + ".host-preload.mjs").href)}).trim() } };
    }
    const child = original.apply(this, args);
    if (gateTrace && launchesHost) {
      hostPid = child.pid;
      const sibling = gateTrace === "foreign-parent"
        ? original.call(this, process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { detached: true, stdio: "ignore" }) : null;
      if (sibling) {
        sibling.unref();
        process.once("exit", () => sibling.kill("SIGKILL"));
      }
      const send = child.send.bind(child);
      child.send = (message, ...rest) => {
        if (message.type === "release_gate") appendFileSync(trace, "gate release " + message.pid + "\\n");
        return send(message, ...rest);
      };
      child.on("message", (reply) => {
        if (sibling && (reply.type === "probe_spawned" || reply.type === "probe_handoff")) {
          reply.pid = sibling.pid;
          reply.start = processStat(sibling.pid)[19];
          fs.writeFileSync(trace + ".foreign-frame", "");
        }
        if (reply.type === "probe_result") appendFileSync(trace, "gate result " + reply.pid + " " + reply.code + "\\n");
        // Fixture control (D1.2 ruling): can this coordinator (same uid, same /proc) follow the host's fd links at the report?
        if (reply.type === "probe_handoff" && !fs.existsSync(trace + ".scan")) {
          let readable = false;
          try { readable = fs.readdirSync("/proc/" + hostPid + "/fd").some(fd => fs.readlinkSync("/proc/" + hostPid + "/fd/" + fd).length > 0); } catch {}
          fs.writeFileSync(trace + ".scan", JSON.stringify({ readable }));
        }
      });
    }
    return child;
  };
}
syncBuiltinESMExports();
`;

  async function boot(label: string, extraImports: string[], env: Record<string, string>, seed?: (dataDir: string) => void, opts: { mayStayDown?: boolean; home?: string; traceGate?: GateTrace } = {}) {
    const port = await freePortBlock([0, 1], 19_420, 200);
    const home = opts.home ?? mkdtempSync(join(tmpdir(), `murage-s1a-${label}-`));
    if (!opts.home) homes.push(home);
    mkdirSync(join(home, ".murage"), { recursive: true });
    if (!opts.home) writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {} }));
    seed?.(join(home, ".murage"));
    const trace = join(home, "trace.txt");
    writeFileSync(trace, "");
    const hook = join(home, "trace-hook.mjs");
    writeFileSync(hook, traceHook(trace, opts.traceGate));
    if (opts.traceGate === "retain-writer") writeFileSync(`${trace}.host-preload.mjs`, retainWriterPreload(trace));
    if (opts.traceGate === "withhold-handoff") writeFileSync(`${trace}.host-preload.mjs`, withholdHandoffPreload(trace));
    let stdout = "", stderr = "";
    const child = spawn(process.execPath, ["--import", pathToFileURL(hook).href, ...extraImports.flatMap(file => ["--import", pathToFileURL(file).href]), join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: ROOT,
      env: childEnv({ HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), ...env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout!.on("data", chunk => (stdout += chunk));
    child.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 45_000;
    for (;;) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (health.ok && ((await health.json()) as { pid?: number }).pid === child.pid) break;
      } catch { /* not up yet */ }
      if ((Date.now() > deadline || child.exitCode !== null) && opts.mayStayDown) return { up: false as const, home, child, stdout, stderr, trace: "", files: [] as string[], schema: {} as Record<string, string[]> };
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server never came up. stderr:\n${stderr.slice(-4000)}`);
      await sleep(25);
    }
    await sleep(500);
    const files: string[] = [];
    // withFileTypes: no stat, so a SQLite temp journal that vanishes mid-walk cannot fail the listing.
    const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = join(dir, entry.name); if (entry.isDirectory()) walk(full); else files.push(relative(home, full)); } };
    walk(join(home, ".murage"));
    // T-S1A-NO-SCHEMA: every SQLite file's sqlite_schema, read through a read-only connection while the server is up.
    const schema = await readSchemas(home, files);
    return { up: true as const, home, child, stdout, stderr, trace: readFileSync(trace, "utf8"), files, schema };
  }

  const noRunner = () => ({ VITEST: "", NODE_TEST_CONTEXT: "" });
  // The HOSTED branch's fail-closed outcome on macOS in S1a: no native start-token producer, so no custody record and no hello.
  const HOSTED_LINE_DARWIN = "[fuigo-mode] mode=COORDINATOR reason=host_no_hello driver=FuigoAgentDriver hello=none forwarderInits=1 custodyUnresolved=0";
  // A boot that ran the HOSTED branch: Linux gets hello from the real host; macOS ends at the line above.
  const HOSTED_BRANCH_RAN = process.platform === "darwin" ? / reason=host_no_hello driver=FuigoAgentDriver hello=none forwarderInits=1 / : / hello=ok forwarderInits=1 /;

  // Every SQLite file's sqlite_schema through a read-only connection. The server may hold a write lock while it builds an
  // index after listen: a busy read is retried whole, so a partial read is never compared.
  async function readSchemas(home: string, files: string[]) {
    for (let attempt = 0; ; attempt++) {
      const schema: Record<string, string[]> = {};
      try {
        for (const file of files.filter(name => /\.(db|sqlite3?)$/.test(name)).sort()) {
          // A database the boot removed after the walk has no schema to compare (a missing one still differs between boots).
          if (!existsSync(join(home, file))) continue;
          const db = new DatabaseSync(join(home, file), { readOnly: true, timeout: 2_000 });
          try { schema[file] = (db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all() as Array<Record<string, unknown>>).map(row => JSON.stringify(row)); } finally { db.close(); }
        }
        return schema;
      } catch (error) {
        // 5 busy; 14 cannot open (the file was replaced or removed during the read): retry the whole read.
        if (![5, 14].includes((error as { errcode?: number }).errcode ?? 0) || attempt >= 50) throw error;
        await sleep(100);
      }
    }
  }

  // Re-reads every database of a booted run until each eager optional index on a table that database holds exists.
  async function settledSchema(run: { home: string; files: string[] }) {
    const eager = OPTIONAL_INDEXES.filter(index => index.eager);
    expect(eager.length, "fixture: memory/schema.ts registered its eager optional indexes").toBeGreaterThan(0);
    let missing: string[] = [];
    for (let i = 0; i < 300; i++) {
      const schema = await readSchemas(run.home, run.files);
      missing = Object.entries(schema).flatMap(([file, rows]) => {
        const parsed = rows.map(row => JSON.parse(row) as { type: string; name: string });
        const tables = new Set(parsed.filter(row => row.type === "table").map(row => row.name));
        const indexes = new Set(parsed.filter(row => row.type === "index").map(row => row.name));
        return eager.filter(index => tables.has(index.table) && !indexes.has(index.name)).map(index => `${file} ${index.name}`);
      });
      if (missing.length === 0) return schema;
      await sleep(100);
    }
    expect(missing, "fixture: the boot built its eager optional indexes").toEqual([]);
    return {};
  }

  const modeLineOf = (run: { stdout: string }) => run.stdout.split("\n").find(line => line.startsWith("[fuigo-mode]"));
  const hostLaunchesOf = (run: { trace: string }) => run.trace.split("\n").filter(line => line.startsWith("spawn ") && /server[\\/]+host[\\/]|host-main|hosted-forwarder/.test(line));

  it("production arguments: COORDINATOR, FuigoAgentDriver, no host launch, no forwarder evaluated, no custody file", async () => {
    const run = await boot("prod", [], noRunner());
    expect(modeLineOf(run), run.stderr.slice(-2000)).toBe("[fuigo-mode] mode=COORDINATOR reason=hosted_unqualified driver=FuigoAgentDriver hello=none forwarderInits=0 custodyUnresolved=0");
    expect(hostLaunchesOf(run)).toEqual([]);
    const loads = run.trace.split("\n").filter(line => line.startsWith("load "));
    expect(loads.filter(line => /hosted-forwarder|host-main|host-launch/.test(line))).toEqual([]);
    expect(run.files.filter(file => /custody/i.test(file))).toEqual([]);
  }, 90_000);

  const nativeAddon = join(ROOT, "dist-native", "engine-exclusion", `${process.platform}-${process.arch}`, "engine-exclusion.node");
  it.skipIf(process.platform !== "linux")("qualifies the hosted exec gate only after custody fsync and a real stdin round trip", async () => {
    // Exercise C5 in CI without the native addon. The adjacent positive control separately pins the real dump policy.
    const fixture = mkdtempSync(join(tmpdir(), "murage-s1a-addon-"));
    homes.push(fixture);
    const addon = join(fixture, "probe-add-on.cjs");
    writeFileSync(addon, `module.exports = { ...require(${JSON.stringify(join(SERVER_DIR, "testing", "engine-exclusion-stub.cjs"))}), disableCoreDumps: () => true };\n`);
    const preload = [join(SERVER_DIR, "testing", "hosted-override-preload.mjs")];
    const env = { VITEST: "true", NODE_ENV: "test", MURAGE_ENGINE_EXCLUSION_PATH: addon };
    const run = await boot("exec-gate", preload, env, undefined, { traceGate: "gate" });
    const events = run.trace.split("\n").filter(line => line.startsWith("gate "));
    expect(events, run.stderr.slice(-2000)).toHaveLength(3);
    const pid = events[0]!.match(/^gate sync (\d+)$/)?.[1];
    expect(pid).toBeDefined();
    expect(events, "custody sync precedes release and the executor exits cleanly").toEqual([`gate sync ${pid}`, `gate release ${pid}`, `gate result ${pid} 0`]);
    const custody = JSON.parse(readFileSync(join(run.home, "trace.txt.custody"), "utf8"));
    expect(custody.actual, "custody identity matches the gate before exec").toEqual(custody.expected);
    expect(custody.directChild, "the recorded process group belongs to a direct host child").toBe(true);
    expect(modeLineOf(run)).toMatch(/reason=forwarder_incomplete /);
    expect(run.files.filter(file => /custody/i.test(file))).toEqual([]);
    const foreign = await boot("exec-foreign", preload, env, undefined, { traceGate: "foreign-parent" });
    expect(existsSync(join(foreign.home, "trace.txt.foreign-frame")), "fixture sent the live sibling identity over the real host channel").toBe(true);
    expect(foreign.trace.split("\n").filter(line => line.startsWith("gate sync ") || line.startsWith("gate release ")), "non-child identity receives no custody record or release").toEqual([]);
    expect(modeLineOf(foreign)).toMatch(/reason=exec_gate_unavailable /);
  }, 120_000);

  // T-W0-STDIN-OWNER (r3 D1.2): a readable fd scan that shows the host still holding the engine's stdin refuses. A host that
  // reports the handoff while it still holds its copy gets no engine custody record, no release, and the boot stays
  // COORDINATOR exec_gate_unavailable. The same probe with the honest host (stub addon, so its fd table stays readable)
  // reaches forwarder_incomplete (test above); a non-dumpable host is accepted on its close report (T-W0-CLOSE-REPORT below).
  it.skipIf(process.platform !== "linux")("refuses the exec gate when the host keeps a copy of the engine's stdin writer after reporting the handoff", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "murage-s1a-addon-"));
    homes.push(fixture);
    const addon = join(fixture, "probe-add-on.cjs");
    writeFileSync(addon, `module.exports = { ...require(${JSON.stringify(join(SERVER_DIR, "testing", "engine-exclusion-stub.cjs"))}), disableCoreDumps: () => true };\n`);
    const env = { VITEST: "true", NODE_ENV: "test", MURAGE_ENGINE_EXCLUSION_PATH: addon };
    const run = await boot("exec-retain", [join(SERVER_DIR, "testing", "hosted-override-preload.mjs")], env, undefined, { traceGate: "retain-writer" });
    const retained = join(run.home, "trace.txt.retained");
    expect(existsSync(retained) ? JSON.parse(readFileSync(retained, "utf8")) : null, "fixture: the real host reported the handoff with its stdin writer still open").toEqual({ socket: true, open: true });
    expect(modeLineOf(run), run.stderr.slice(-2000)).toMatch(/reason=exec_gate_unavailable /);
    expect(run.trace.split("\n").filter(line => line.startsWith("gate sync ") || line.startsWith("gate release ")), "a shared stdin writer gets no engine custody record and no release").toEqual([]);
    expect(run.files.filter(file => /custody/i.test(file))).toEqual([]);
  }, 120_000);

  // T-W0-CLOSE-REPORT (MAIN-RULING 2026-11-22T15:22:59Z o1m2-D1.2-vs-A12, option (2)): with the real core-dump addon the host
  // is non-dumpable (A12 kept), so the coordinator cannot read its fd links. The host's close report is accepted on Linux as on
  // macOS: custody is written, the gate released and the executor round trip completes (forwarder_incomplete). A host that
  // never sends the report is refused stdin_owner_unconfirmed, with no engine custody record and no release.
  it.skipIf(process.platform !== "linux")("T-W0-CLOSE-REPORT: a non-dumpable host's close report lets custody proceed", async () => {
    expect(existsSync(nativeAddon), "fixture: the real engine-exclusion addon is staged").toBe(true);
    const env = { VITEST: "true", NODE_ENV: "test", MURAGE_ENGINE_EXCLUSION_PATH: nativeAddon };
    const run = await boot("close-report", [join(SERVER_DIR, "testing", "hosted-override-preload.mjs")], env, undefined, { traceGate: "gate" });
    const scan = join(run.home, "trace.txt.scan");
    expect(existsSync(scan) ? JSON.parse(readFileSync(scan, "utf8")) : null, "fixture: the host reported the close and its fd links were unreadable to the coordinator").toEqual({ readable: false });
    const events = run.trace.split("\n").filter(line => line.startsWith("gate "));
    const pid = events[0]?.match(/^gate sync (\d+)$/)?.[1];
    expect(events, `${modeLineOf(run)}\n${run.stderr.slice(-2000)}`).toEqual([`gate sync ${pid}`, `gate release ${pid}`, `gate result ${pid} 0`]);
    expect(modeLineOf(run)).toMatch(/ reason=forwarder_incomplete /);
    expect(run.files.filter(file => /custody/i.test(file))).toEqual([]);
  }, 120_000);

  it.skipIf(process.platform !== "linux")("T-W0-CLOSE-REPORT: a host that never reports the close is stdin_owner_unconfirmed", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "murage-s1a-addon-"));
    homes.push(fixture);
    const addon = join(fixture, "probe-add-on.cjs");
    writeFileSync(addon, `module.exports = { ...require(${JSON.stringify(join(SERVER_DIR, "testing", "engine-exclusion-stub.cjs"))}), disableCoreDumps: () => true };\n`);
    const env = { VITEST: "true", NODE_ENV: "test", MURAGE_ENGINE_EXCLUSION_PATH: addon };
    const run = await boot("no-report", [join(SERVER_DIR, "testing", "hosted-override-preload.mjs")], env, undefined, { traceGate: "withhold-handoff" });
    expect(existsSync(join(run.home, "trace.txt.withheld")), "fixture: the real host dropped its close report").toBe(true);
    expect(modeLineOf(run), run.stderr.slice(-2000)).toMatch(/ reason=stdin_owner_unconfirmed /);
    expect(run.trace.split("\n").filter(line => line.startsWith("gate sync ") || line.startsWith("gate release ")), "no report: no engine custody record and no release").toEqual([]);
    expect(run.files.filter(file => /custody/i.test(file))).toEqual([]);
  }, 120_000);

  // Positive control for every trace above (Opus M1, M5): with the one named preload the boot reaches the HOSTED branch,
  // evaluates the forwarder once, launches the real host through a module that imports spawn BY NAME (host-launch.ts),
  // gets hello from it, and still stays COORDINATOR (the turn path is not built), with the host shut down and reaped.
  it("positive control: the named preload reaches the HOSTED branch, launches the host, gets hello, and stays COORDINATOR with custody reaped", async () => {
    const env = { VITEST: "true", ...(process.platform === "linux" && existsSync(nativeAddon) ? { MURAGE_ENGINE_EXCLUSION_PATH: nativeAddon } : {}) };
    const run = await boot("override", [join(SERVER_DIR, "testing", "hosted-override-preload.mjs")], env);
    const line = modeLineOf(run) ?? "";
    // Opus r2 M: the reason is pinned to this machine's core-dump addon, probed in a separate process (the same call the host
    // and the coordinator make), so a boot that lost its policy cannot pass as forwarder_incomplete or the other way round.
    // r9 (MAIN-RULING o1m2-D1.2-vs-A12 option (2)): r8 also pinned stdin_owner_unconfirmed when this runner could not read a
    // non-dumpable process's fd links. The ruling accepts the host's close report there, so with the policy applied the exec
    // gate qualifies whether or not the fd scan is readable (T-W0-CLOSE-REPORT witnesses the unreadable case directly).
    const probe = spawn(process.execPath, ["--input-type=module", "-e", `import { loadExclusionAddon } from ${JSON.stringify(pathToFileURL(join(SERVER_DIR, "engine-exclusion.ts")).href)};
let ok = false; try { ok = loadExclusionAddon()?.disableCoreDumps?.() === true; } catch {} process.stdout.write(String(ok) + "\\n"); process.stdin.resume();`], { cwd: ROOT, env: childEnv(env), stdio: ["pipe", "pipe", "inherit"] });
    children.push(probe);
    const dumps = await new Promise<string>(resolve => { let out = ""; probe.stdout!.setEncoding("utf8").on("data", chunk => { out += chunk; if (out.includes("\n")) resolve(out.trim()); }); probe.once("exit", () => resolve(out.trim())); });
    probe.stdin!.end();
    expect(dumps).toMatch(/^(true|false)$/);
    const reason = dumps !== "true" ? "dump_policy_unavailable" : "forwarder_incomplete";
    // macOS (design r3 D1.6): the start-token producer is the native proc_pidinfo owner, which S1a does not ship, so the host
    // gets no custody record, is killed, and the boot stays COORDINATOR with host_no_hello (Astra r9 High 2, MACRUN-REQ).
    expect(line, run.stderr.slice(-2000)).toBe(process.platform === "darwin" ? HOSTED_LINE_DARWIN
      : `[fuigo-mode] mode=COORDINATOR reason=${reason} driver=FuigoAgentDriver hello=ok forwarderInits=1 custodyUnresolved=0`);
    expect(run.files.filter(file => /custody/i.test(file)), "no custody file is left after the host is shut down").toEqual([]);
    expect(run.trace).toMatch(/^load .*\/server\/host\/hosted-forwarder\.ts$/m);
    expect(hostLaunchesOf(run).filter(entry => entry.includes("host-main.ts"))).toHaveLength(1);
    expect(run.files.filter(file => /custody/i.test(file))).toEqual([]);
  }, 90_000);

  // Fail-closed reap (DECISIONS r3 D7): a custody file that exists but cannot be read is kept and counted unresolved; before
  // r3 the boot reap threw at top level and the server never came up. The runner is not root, so mode 000 denies the read.
  it.skipIf(process.platform === "win32")("an unreadable custody file is kept, counted unresolved, and does not stop the boot", async () => {
    let custody = "";
    const run = await boot("unreadable", [], noRunner(), dataDir => {
      custody = join(dataDir, "hosted-custody.jsonl");
      writeFileSync(custody, "{}\n");
      chmodSync(custody, 0o000); expect(() => readFileSync(custody), "fixture: the runner is not root, so mode 000 denies the read").toThrow(/EACCES/);
    }, { mayStayDown: true });
    try {
      expect(run.up, run.stderr.slice(-2000)).toBe(true);
      expect(modeLineOf(run)).toBe("[fuigo-mode] mode=COORDINATOR reason=stale_executor driver=FuigoAgentDriver hello=none forwarderInits=0 custodyUnresolved=1");
      expect(existsSync(custody)).toBe(true);
    } finally { if (custody) chmodSync(custody, 0o600); }
  }, 90_000);

  // T-S1A-NO-SCHEMA (r5 F3): reaching the HOSTED branch (forwarder, host launch, hello, custody record, reap) changes no
  // database schema and leaves no file in the data dir that a production boot of the same fixture does not leave. The
  // production schema itself is today's (this lane adds no DDL); the regression this guards is lane DDL or a lane file.
  it("T-S1A-NO-SCHEMA: a HOSTED-branch boot leaves the production boot's sqlite_schema and data-dir files", async () => {
    const prod = await boot("schema-prod", [], noRunner());
    const hosted = await boot("schema-hosted", [join(SERVER_DIR, "testing", "hosted-override-preload.mjs")], { VITEST: "true" });
    expect(modeLineOf(hosted) ?? "", hosted.stderr.slice(-2000)).toMatch(HOSTED_BRANCH_RAN);
    expect(Object.keys(prod.schema).length, "fixture: the boot created its databases").toBeGreaterThan(0);
    // Same production milestone on both boots: the eager optional indexes (memory/schema.ts, e.g. memory_records_waiting_review)
    // are built after listen, so a read straight after /api/health can land on either side of that build.
    prod.schema = await settledSchema(prod);
    hosted.schema = await settledSchema(hosted);
    expect(Object.entries(hosted.schema).flatMap(([file, rows]) => prod.schema[file] ? rows.filter(row => !prod.schema[file]!.includes(row)).map(row => `${file} ${row}`) : [`${file} (database only in the HOSTED boot)`])).toEqual([]);
    // F3 "no new file": nothing the HOSTED-branch boot leaves that the production boot does not (SQLite journals and
    // pid-named atomic-write temps are transient; a lazily written production file may land in either boot or neither).
    const durable = (files: string[]) => files.filter(file => file.startsWith(".murage") && !/-(wal|shm|journal)$|\.\d+\.\w+\.tmp$/.test(file));
    const prodFiles = new Set(durable(prod.files));
    expect(durable(hosted.files).filter(file => !prodFiles.has(file))).toEqual([]);
  }, 120_000);

  // T-S1A-NO-SCHEMA, upgraded data dir (r3 Astra open item): an existing user data dir, made and stopped by a production
  // boot, is restarted on the HOSTED branch. Its schema must equal the production reference read before the restart, both
  // ways (no row added, none dropped or rewritten), and the restart leaves no durable file the production boot did not.
  it("T-S1A-NO-SCHEMA: a HOSTED-branch restart of a production data dir keeps its sqlite_schema exactly", async () => {
    const prod = await boot("schema-upg", [], noRunner());
    expect(Object.keys(prod.schema).length, "fixture: the boot created its databases").toBeGreaterThan(0);
    // Steady state first: the derived skill index (data-dir-inventory.ts DERIVED_SKILLS) is built in the background after boot.
    for (let i = 0; i < 300 && !existsSync(join(prod.home, ".murage", "skill-index.db")); i++) await sleep(100);
    expect(existsSync(join(prod.home, ".murage", "skill-index.db")), "fixture: the production boot built its skill index").toBe(true);
    await waitForExit(prod.child, { signal: "SIGTERM" });
    expect(prod.child.exitCode !== null || prod.child.signalCode !== null, "fixture: the production boot stopped").toBe(true);
    const stoppedFiles = (readdirSync(join(prod.home, ".murage"), { recursive: true, withFileTypes: true }) as Array<{ isFile(): boolean; name: string; parentPath: string }>)
      .filter(entry => entry.isFile()).map(entry => relative(prod.home, join(entry.parentPath, entry.name)));
    // The reference is read after the production boot stopped, so tables it created lazily while up are in it.
    const reference: Record<string, string[]> = {};
    for (const file of stoppedFiles.filter(name => /\.(db|sqlite3?)$/.test(name)).sort()) {
      const db = new DatabaseSync(join(prod.home, file), { readOnly: true });
      try { reference[file] = (db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all() as Array<Record<string, unknown>>).map(row => JSON.stringify(row)); } finally { db.close(); }
    }
    const hosted = await boot("schema-upg-hosted", [join(SERVER_DIR, "testing", "hosted-override-preload.mjs")], { VITEST: "true" }, undefined, { home: prod.home });
    expect(modeLineOf(hosted) ?? "", "the restart ran the HOSTED branch (forwarder, host, hello)").toMatch(HOSTED_BRANCH_RAN);
    expect(hosted.schema, "upgraded dir schema == production reference").toEqual(reference);
    const durable = (files: string[]) => files.filter(file => file.startsWith(".murage") && !/-(wal|shm|journal)$|\.\d+\.\w+\.tmp$/.test(file));
    const prodFiles = new Set(durable(stoppedFiles));
    expect(durable(hosted.files).filter(file => !prodFiles.has(file)), "no new durable file after the restart").toEqual([]);
  }, 150_000);

  // F3 reap rule: a custody file left by an earlier HOSTED boot is reaped by a production COORDINATOR boot, before the
  // decision. The recorded executor is a real detached process with its real start token; it must be dead after boot.
  it.skipIf(process.platform !== "linux")("F3: a production boot reaps a leftover custody file by identity, then removes it", async () => {
    const leftover = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    children.push(leftover);
    await new Promise(resolve => leftover.once("spawn", resolve));
    const start = readFileSync(`/proc/${leftover.pid}/stat`, "utf8").split(") ")[1]!.split(/\s+/)[19]!;
    const run = await boot("reap", [], noRunner(), dataDir => writeFileSync(join(dataDir, "hosted-custody.jsonl"),
      `${JSON.stringify({ boot_id: "fixture-boot", kboot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), inc: 1, role: "engine", pid: leftover.pid, start, pgid: leftover.pid })}\n`));
    expect(modeLineOf(run), run.stderr.slice(-2000)).toBe("[fuigo-mode] mode=COORDINATOR reason=hosted_unqualified driver=FuigoAgentDriver hello=none forwarderInits=0 custodyUnresolved=0");
    // Observe only: waitForExit would send its own SIGKILL and make this assertion tautological.
    const gone = leftover.exitCode !== null || leftover.signalCode !== null
      || await Promise.race([new Promise<boolean>(resolve => leftover.once("exit", () => resolve(true))), sleep(5_000).then(() => false)]);
    expect({ gone, signal: leftover.signalCode }).toEqual({ gone: true, signal: "SIGKILL" });
    expect(run.files.filter(file => /custody/i.test(file))).toEqual([]);
    expect(hostLaunchesOf(run)).toEqual([]);
  }, 90_000);
});

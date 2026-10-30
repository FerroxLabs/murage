// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkInstall, invokedAsMain, main, parseArgs, registrationMatches, type RegistrationState } from "./cli.ts";
import { writeDescriptor } from "./paths.ts";
import { runScan } from "./scan.ts";
import { T0, cleanupFixtures, makeInstall, type FixtureInstall } from "./scan-fixtures.ts";
import { EXIT } from "./supervisor.ts";

afterEach(() => cleanupFixtures());

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

function registration(fx: FixtureInstall, overrides: Partial<RegistrationState> = {}): RegistrationState {
  return {
    mechanism: "systemd", registered: true, executable: fx.descriptor.executable.path, args: [fx.descriptor.executable.entry, fx.descriptorPath, "--once"],
    owner: "owner", revision: fx.descriptor.scheduleRevision, lastResult: 0, ...overrides,
  };
}

describe("arguments", () => {
  it("accepts exactly a descriptor and one of the three service modes", () => {
    expect(parseArgs(["/x/descriptor.json", "--once"])).toEqual({ descriptor: "/x/descriptor.json", mode: "--once" });
    expect(parseArgs(["/x/descriptor.json", "--watch"])?.mode).toBe("--watch");
    expect(parseArgs(["/x/descriptor.json", "--check-install"])?.mode).toBe("--check-install");
    expect(parseArgs(["/x/descriptor.json"])).toBeNull();
    expect(parseArgs(["/x/descriptor.json", "--once", "--verbose"])).toBeNull();
    expect(parseArgs(["/x/descriptor.json", "--scan-now"])).toBeNull();
    expect(parseArgs(["--once", "/x/descriptor.json"])).toBeNull();
  });

  it("accepts AppRun's --no-sandbox only as the single trailing argument on Linux", () => {
    expect(parseArgs(["/x/descriptor.json", "--once", "--no-sandbox"], "linux")).toEqual({ descriptor: "/x/descriptor.json", mode: "--once" });
    expect(parseArgs(["/x/descriptor.json", "--watch", "--no-sandbox"], "linux")?.mode).toBe("--watch");
    expect(parseArgs(["/x/descriptor.json", "--once", "--no-sandbox"], "darwin")).toBeNull();
    expect(parseArgs(["/x/descriptor.json", "--once", "--no-sandbox"], "win32")).toBeNull();
    expect(parseArgs(["--no-sandbox", "/x/descriptor.json", "--once"], "linux")).toBeNull();
    expect(parseArgs(["/x/descriptor.json", "--once", "--no-sandbox", "--no-sandbox"], "linux")).toBeNull();
    expect(parseArgs(["/x/descriptor.json", "--no-sandbox"], "linux")).toBeNull();
  });

  it("answers usage for anything else, without touching the filesystem", async () => {
    const lines: string[] = [];
    expect(await main(["--help"], { out: line => lines.push(line) })).toBe(EXIT.usage);
    expect(JSON.parse(lines[0]!)).toEqual({ status: "usage" });
  });

  it("refuses a descriptor it cannot validate", async () => {
    const lines: string[] = [];
    expect(await main(["/nonexistent/MurageSentinel/x/descriptor.json", "--once"], { out: line => lines.push(line) })).toBe(EXIT.usage);
    expect(JSON.parse(lines[0]!).status).toBe("descriptor-refused");
  });
});

describe("--once", () => {
  it("as the supervised child, runs one scan in process and exits with its status", async () => {
    const fx = makeInstall();
    const lines: string[] = [];
    const code = await main([fx.descriptorPath, "--once"], { env: { MURAGE_SENTINEL_CHILD: "1" }, out: line => lines.push(line) });
    expect(code).toBe(EXIT.ok);
    expect(JSON.parse(lines[0]!).status).toBe("published");
  });

  it("as the supervisor, runs the scan in a child with the allowlisted environment and passes its exit code on", async () => {
    const fx = makeInstall();
    const seen: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
    const code = await main([fx.descriptorPath, "--once"], {
      env: { HOME: "/home/owner", ANTHROPIC_API_KEY: "sk-secret" }, out: () => {}, entry: "/opt/Murage/cli.js", execArgv: [],
      spawnChild: spec => { seen.push({ args: spec.args, env: spec.env }); return spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", env: {} }); },
    });
    expect(code).toBe(EXIT.ok);
    expect(seen[0]!.args).toEqual(["/opt/Murage/cli.js", fx.descriptorPath, "--once"]);
    expect(seen[0]!.env).toEqual({ HOME: "/home/owner", MURAGE_SENTINEL_CHILD: "1" });
  });

  it("records a scan killed at the deadline as a failed attempt", async () => {
    const fx = makeInstall();
    await main([fx.descriptorPath, "--once"], {
      env: {}, out: () => {}, entry: "/opt/Murage/cli.js", execArgv: [], deadlineMs: 200,
      spawnChild: () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: {} }),
    });
    const failures = JSON.parse(readFileSync(join(fx.descriptor.outputRoot, "failures.json"), "utf8")) as { failures: number[] };
    expect(failures.failures).toHaveLength(1);
  });
});

describe("--check-install", () => {
  it("is proven only when a registration runs this entry and descriptor at this revision AND a fresh heartbeat exists", async () => {
    const fx = makeInstall();
    const reader = () => registration(fx);
    expect((await checkInstall(fx.descriptorPath, { registrationReaders: [reader], now: () => T0 })).state).toBe("registered");
    runScan({ descriptor: fx.descriptor, now: () => T0, budget: { cpuMicros: () => 0, rssBytes: () => 0 } });
    const proven = await checkInstall(fx.descriptorPath, { registrationReaders: [reader], now: () => T0 + 60_000 });
    expect(proven).toMatchObject({ state: "proven", heartbeatFresh: true, installationId: fx.descriptor.installationId });
    const stale = await checkInstall(fx.descriptorPath, { registrationReaders: [reader], now: () => T0 + 6 * 60 * 60_000 });
    expect(stale.state).toBe("registered");
  });

  it("a registration that exists but points elsewhere needs re-registration; none at all is unregistered", async () => {
    const fx = makeInstall();
    runScan({ descriptor: fx.descriptor, now: () => T0, budget: { cpuMicros: () => 0, rssBytes: () => 0 } });
    const wrongArgs = () => registration(fx, { args: ["/tmp/other.js", fx.descriptorPath, "--once"] });
    const oldRevision = () => registration(fx, { revision: 0 });
    expect((await checkInstall(fx.descriptorPath, { registrationReaders: [wrongArgs], now: () => T0 })).state).toBe("registration-needed");
    expect((await checkInstall(fx.descriptorPath, { registrationReaders: [oldRevision], now: () => T0 })).state).toBe("registration-needed");
    expect((await checkInstall(fx.descriptorPath, { registrationReaders: [], now: () => T0 })).state).toBe("unregistered");
    const throwing = () => { throw new Error("launchctl failed"); };
    expect((await checkInstall(fx.descriptorPath, { registrationReaders: [throwing], now: () => T0 })).state).toBe("unregistered");
  });

  it("matches arguments exactly, never by substring", () => {
    const fx = makeInstall();
    expect(registrationMatches(registration(fx), fx.descriptor, fx.descriptorPath)).toBe(true);
    expect(registrationMatches(registration(fx, { args: [`${fx.descriptor.executable.entry} `, fx.descriptorPath, "--once"] }), fx.descriptor, fx.descriptorPath)).toBe(false);
    expect(registrationMatches(registration(fx, { executable: "/usr/bin/node" }), fx.descriptor, fx.descriptorPath)).toBe(false);
    expect(registrationMatches(registration(fx, { registered: false }), fx.descriptor, fx.descriptorPath)).toBe(false);
  });

  it("prints one JSON line and exits non-zero until proven", async () => {
    const fx = makeInstall();
    const lines: string[] = [];
    expect(await main([fx.descriptorPath, "--check-install"], { out: line => lines.push(line), registrationReaders: [] })).toBe(EXIT.notProven);
    expect(JSON.parse(lines[0]!).state).toBe("unregistered");
  });
});

describe("--watch", () => {
  it("retires by itself once another scheduler moved the descriptor's revision on", async () => {
    const fx = makeInstall();
    const timers: Array<() => void> = [];
    let scans = 0;
    const fakeChild = () => {
      scans++;
      const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => boolean };
      child.pid = 1;
      child.kill = () => true;
      setImmediate(() => child.emit("exit", 0, null));
      return child as never;
    };
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));
    const running = main([fx.descriptorPath, "--watch"], { spawnChild: fakeChild, setTimer: fn => { timers.push(fn); return 0; }, untilStopped: () => new Promise(() => {}), out: () => {} });
    await settle();
    timers.shift()!(); await settle();
    expect(scans).toBe(2);
    expect(writeDescriptor({ ...fx.descriptor, scheduleRevision: fx.descriptor.scheduleRevision + 1 }).ok).toBe(true);
    timers.shift()!(); await settle();
    timers.shift()!(); await settle();
    expect(await running).toBe(EXIT.ok);
    expect(scans).toBe(2);
  });
});

describe("cli import graph", () => {
  const FORBIDDEN_SPECIFIERS = [/^(node:)?https?$/, /^(node:)?net$/, /^(node:)?tls$/, /^(node:)?dgram$/, /^(node:)?http2$/, /^undici/, /^ws$/];
  const FORBIDDEN_FILES = [/^server\/index\.ts$/, /^server\/database\.ts$/, /^server\/drivers\//, /^server\/config/, /^server\/memory\//, /^server\/health\//];

  function walk(entry: string) {
    const seen = new Set<string>();
    const external = new Set<string>();
    const stack = [entry];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      const specifiers = [
        ...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g),
        ...source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g),
        ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
        ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
      ].map(m => m[1]!);
      for (const spec of specifiers) {
        if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
        else external.add(spec);
      }
    }
    return { files: [...seen].map(f => relative(ROOT, f).split("\\").join("/")), external: [...external] };
  }

  it("never reaches server startup, the live database opener, drivers, credential config or any network module", () => {
    const { files, external } = walk(join(HERE, "cli.ts"));
    expect(files).toContain("server/sentinel/scan.ts");
    expect(files).toContain("shared/health-protocol.mjs");
    for (const file of files) for (const pattern of FORBIDDEN_FILES) expect(file, `${file} is forbidden in the scanner`).not.toMatch(pattern);
    for (const spec of external) for (const pattern of FORBIDDEN_SPECIFIERS) expect(spec, `${spec} is forbidden in the scanner`).not.toMatch(pattern);
    for (const spec of external) expect(spec.startsWith("node:"), `${spec} must be a node: built-in`).toBe(true);
    for (const file of files) {
      const code = readFileSync(join(ROOT, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code, `${file} must not use fetch or sockets`).not.toMatch(/\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b/);
    }
  });
});

describe("the checker starts when run through a symlinked install", () => {
  it("argv[1] through a symlinked directory still names the module, so main() runs on a Cloud home", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "murage-sentinel-main-")));
    try {
      const real = join(base, "slot-a", "dist-server", "sentinel");
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, "cli.js"), "");
      symlinkSync(join(base, "slot-a"), join(base, "murage"), process.platform === "win32" ? "junction" : "dir");
      const moduleUrl = pathToFileURL(join(real, "cli.js")).href;
      expect(invokedAsMain(join(base, "murage", "dist-server", "sentinel", "cli.js"), moduleUrl)).toBe(true);
      expect(invokedAsMain(join(real, "cli.js"), moduleUrl)).toBe(true);
      writeFileSync(join(real, "other.js"), "");
      expect(invokedAsMain(join(base, "murage", "dist-server", "sentinel", "other.js"), moduleUrl)).toBe(false);
      expect(invokedAsMain(join(base, "missing.js"), moduleUrl)).toBe(false);
      expect(invokedAsMain(undefined, moduleUrl)).toBe(false);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

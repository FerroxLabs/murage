import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import type { ClaudeS2Qualification } from "./claude-s2-qualification.ts";
import { removeTempDir } from "../testing/cleanup.ts";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock("./process-tree.ts", async original => ({ ...await original<typeof import("./process-tree.ts")>(),
  descendantBaseline: async () => new Set<number>(), untrackedDescendants: async () => new Set<number>(),
}));
// Older default-on revisions have no qualification module. Assert that
// missing product contract before using it, rather than failing collection.
const qualificationModule = existsSync(new URL("claude-s2-qualification.ts", import.meta.url))
  ? await import("./claude-s2-qualification.ts") : null;
function qualificationApi() {
  expect(qualificationModule).not.toBeNull();
  return qualificationModule!;
}
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs();
});
const receipt = (build: string): ClaudeS2Qualification => ({
  platform: "linux", arch: "fixture", version: "0.0.0", build, evidence: "isolated-reviewed-receipt",
});
function artifact(bytes: Buffer) {
  const root = mkdtempSync(join(tmpdir(), "s2-identity-"));
  cleanups.push(() => removeTempDir(root));
  const file = join(root, "native-cli"); writeFileSync(file, bytes);
  return { root, file, build: createHash("sha256").update(bytes).digest("hex") };
}

it("A-F3a unqualified identity → S1", async () => {
  const qualification = qualificationApi();
  const x = artifact(Buffer.from("\x7fELFisolated-native-artifact"));
  const reviewed = receipt(x.build);
  const admitted = (platform: NodeJS.Platform, arch: string, version: string | null, build: string | null) =>
    qualification.claudeS2Qualified({}, platform, version, build, arch, [reviewed]);
  expect(admitted("linux", "fixture", "0.0.0", x.build)).toBe(true);
  for (const [platform, arch, version, build] of [
    ["darwin", "fixture", "0.0.0", x.build], ["linux", "other", "0.0.0", x.build],
    ["linux", "fixture", "0.0.1", x.build], ["linux", "fixture", "0.0.0", "1".repeat(64)],
    ["linux", "fixture", "0.0.0", null],
  ] as const) expect(admitted(platform, arch, version, build)).toBe(false);
  for (const source of ["#!/bin/sh\nexec alternate-cli\n", "#!/usr/bin/env node\nimport 'alternate-cli';\n"]) {
    const wrapper = artifact(Buffer.from(source));
    expect(await qualification.claudeS2NativeBuild(wrapper.file)).toBeNull();
    expect(await qualification.claudeS2QualifiedCli(wrapper.file, "0.0.0", {}, "linux", "fixture", [receipt(wrapper.build)])).toBe(false);
  }
  expect(await qualification.claudeS2QualifiedCli("relative-cli", "0.0.0", {}, "linux", "fixture", [reviewed])).toBe(false);
  expect(await qualification.claudeS2QualifiedCli(join(x.root, "absent"), "0.0.0", {}, "linux", "fixture", [reviewed])).toBe(false);

  // Exercise the public driver as well: rejected wrapper identities use two
  // concrete processes, and no retained-generation reconnect is sent.
  const runtime = await runtimeFixture(false);
  const first = await runtime.instance.adapter.sendTurn(runtime.turn("first"));
  expect(await runtime.events.until(event => event.type === "turn.completed" && event.turnId === first.turnId)).toMatchObject({ ok: true });
  await runtime.instance.adapter.sendTurn(runtime.turn("second"));
  await expect.poll(() => runtime.users().length, { timeout: 20_000 }).toBe(2);
  expect(runtime.users()[1]!.pid).not.toBe(runtime.users()[0]!.pid);
  expect(runtime.rows().some(row => row.frame.request?.subtype === "mcp_reconnect")).toBe(false);
}, 60_000);

it("A-F3b the environment can never qualify S2", async () => {
  const qualification = qualificationApi();
  for (const env of [{ NODE_ENV: "test" }, { NODE_ENV: "production" }, {}]) {
    expect(qualification.claudeS2Qualified(env, "linux", "0.0.0", "0".repeat(64), "fixture")).toBe(false);
    expect(await qualification.claudeS2QualifiedCli("relative-cli", "0.0.0", env, "linux", "fixture")).toBe(false);
  }
});

it("A-F3c the digest is cached by identity, never per turn", async () => {
  const qualification = qualificationApi();
  // Assert the missing contract first, so an old revision fails on an
  // assertion rather than throwing a missing-function infrastructure error.
  expect(qualification.prepareClaudeS2NativeBuild).toEqual(expect.any(Function));
  const bytes = Buffer.alloc(64 * 1024 * 1024); bytes.write("\x7fELF");
  const x = artifact(bytes), reviewed = [receipt(x.build)];
  const qualify = () => qualification.claudeS2QualifiedCli(x.file, "0.0.0", {}, "linux", "fixture", reviewed);
  const controlStart = performance.now();
  await qualification.claudeS2QualifiedCli(x.file, "0.0.1", {}, "linux", "fixture", reviewed);
  const controlMs = performance.now() - controlStart;
  const missStart = performance.now();
  expect(await qualify()).toBe(false);
  expect(performance.now() - missStart - controlMs).toBeLessThan(5);
  expect(fs.createReadStream).not.toHaveBeenCalled();
  expect(await qualification.prepareClaudeS2NativeBuild(x.file)).toBe(x.build);
  for (let turn = 0; turn < 3; turn++) expect(await qualify()).toBe(true);
  expect(fs.createReadStream).toHaveBeenCalledTimes(1);

  const before = statSync(x.file);
  utimesSync(x.file, before.atime, new Date(before.mtimeMs + 2_000));
  expect(await qualify()).toBe(false);
  expect(await qualification.prepareClaudeS2NativeBuild(x.file)).toBe(x.build);
  expect(await qualify()).toBe(true);
  expect(fs.createReadStream).toHaveBeenCalledTimes(2);

  bytes[bytes.length - 1] = 1;
  writeFileSync(x.file, bytes);
  // Same length with the previous mtime restored still differs by ctime.
  utimesSync(x.file, before.atime, new Date(before.mtimeMs + 2_000));
  expect(await qualify()).toBe(false);
  expect(await qualification.prepareClaudeS2NativeBuild(x.file)).not.toBe(x.build);
  expect(await qualify()).toBe(false);
  expect(fs.createReadStream).toHaveBeenCalledTimes(3);
});

async function runtimeFixture(qualified: boolean) {
  const qualification = qualificationApi();
  const { ClaudeDriver, resetClaudeMcpReadinessForTests } = await import("./claude.ts");
  const { resetClaudeVersionGate } = await import("./claude-guards.ts");
  const { fixtureMountTurn } = await import("../testing/mcp-admission-fixture.ts");
  const { recordEvents } = await import("../testing/events.ts");
  const { ensureDirs } = await import("../config.ts");
  ensureDirs();
  const root = mkdtempSync(join(tmpdir(), "s2-stop-only-"));
  cleanups.push(() => removeTempDir(root));
  // An executable wrapper preserves the fixture's relative module graph.
  const cli = join(root, "claude.mjs"), log = join(root, "stdin.jsonl"), release = join(root, "release");
  writeFileSync(cli, `#!/usr/bin/env node\nimport ${JSON.stringify(new URL("claude-s2-runtime-cli.fixture.mjs", import.meta.url).href)};\n`);
  chmodSync(cli, 0o755);
  writeFileSync(release, "ready");
  vi.stubEnv("FAKE_CLAUDE_S2_LOG", log); vi.stubEnv("FAKE_CLAUDE_S2_RELEASE", release);
  vi.stubEnv("CLAUDE_CONFIG_DIR", root); vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  if (qualified) {
    const injected = receipt("0".repeat(64));
    vi.spyOn(qualification, "claudeS2QualifiedCli").mockImplementation(async () => qualification.claudeS2Qualified({},
      injected.platform, injected.version, injected.build, injected.arch, [injected]));
    // This lifecycle fixture injects the same reviewed qualification at both
    // admission boundaries. A-F3e/f exercise real descriptor/launch identity.
    vi.spyOn(qualification, "claudeS2QualifiedCliNow").mockImplementation(() => qualification.claudeS2Qualified({},
      injected.platform, injected.version, injected.build, injected.arch, [injected]));
  }
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "Isolated qualification fixture",
    enabled: true, environment: {}, config: { cli, permissionMode: "acceptEdits" } });
  const events = recordEvents(instance.adapter), threadId = randomUUID(), botId = randomUUID();
  cleanups.push(async () => { events.stop(); await instance.dispose(); resetClaudeMcpReadinessForTests(); resetClaudeVersionGate(); });
  const turn = (text: string) => fixtureMountTurn({ threadId, text, cwd: root, draftOnly: true,
    warmIdentity: { botId, audience: "owner" },
    integrations: { composio: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } } });
  type Row = { pid: number; frame: { type: string; request?: { subtype: string } } };
  const rows = (): Row[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  return { instance, events, threadId, turn, rows, users: () => rows().filter(row => row.frame.type === "user") };
}

it("A-F3d a Stop alone tears down retained mounts", async () => {
  const { CliMountRelay } = await import("./cli-mount-relay.ts");
  const relays: Awaited<ReturnType<typeof CliMountRelay.create>>[] = [];
  const create = CliMountRelay.create;
  vi.spyOn(CliMountRelay, "create").mockImplementation(async (...args) => {
    const relay = await create(...args); relays.push(relay); return relay;
  });
  const runtime = await runtimeFixture(true);
  const first = await runtime.instance.adapter.sendTurn(runtime.turn("first"));
  expect(await runtime.events.until(event => event.type === "turn.completed" && event.turnId === first.turnId)).toMatchObject({ ok: true });
  expect(relays).toHaveLength(1);
  const relay = relays[0]!, pid = runtime.users()[0]!.pid;
  expect(() => process.kill(pid, 0)).not.toThrow();
  const credentialPath = relay.cred!.path;
  expect(existsSync(credentialPath)).toBe(true);
  const credentialDir = dirname(credentialPath), mountChildren = [...relay.mounts.values()].map(mount => mount.child);
  const started = performance.now();
  await runtime.instance.adapter.interruptTurn(runtime.threadId);
  await expect.poll(() => existsSync(credentialPath), { timeout: 10_000 }).toBe(false);
  expect(existsSync(credentialDir)).toBe(false);
  await expect.poll(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, { timeout: 10_000 }).toBe(true);
  expect(mountChildren.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(runtime.users()).toHaveLength(1);
}, 60_000);

it("PRODUCT-BROKER-RETIRE keeps the system-denial receipt before cutting the old generation", async () => {
  const { createPermissionBroker, permissionSocketPath } = await import("./claude.ts");
  const { connect } = await import("node:net");
  const root = mkdtempSync(join(tmpdir(), "broker-receipt-"));
  cleanups.push(() => removeTempDir(root));
  const asked: string[] = [];
  const resolved: Array<{ id: string; behavior: string; source: string }> = [];
  const socketPath = process.platform === "win32" ? permissionSocketPath(`broker-receipt-${randomUUID()}`) : join(root, "broker.sock");
  const broker = await createPermissionBroker({ socketPaths: [socketPath],
    onAsk: ask => asked.push(ask.id), onResolve: ask => resolved.push(ask) });
  cleanups.push(() => broker.close());
  const client = connect(broker.socketPath); cleanups.push(() => client.destroy());
  await new Promise<void>((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  const frames: string[] = [];
  client.on("data", chunk => frames.push(chunk.toString()));
  client.write(JSON.stringify({ t: "ask", id: "retire-ready", tool: "Bash", input: { command: "echo fixture" } }) + "\n");
  await expect.poll(() => asked).toEqual(["retire-ready"]);
  const retired = broker.nextGeneration();
  expect(broker.answer("retire-ready", "allow")).toBe(false);
  await retired;
  await expect.poll(() => frames.join("")).toContain('"behavior":"deny"');
  expect(resolved).toMatchObject([{ id: "retire-ready", behavior: "deny", source: "system" }]);
  expect(broker.isPending("retire-ready")).toBe(false);
});

it("PRODUCT-BROKER-RETIRE bounds an absent receipt and immediately closes card and allow ingress", async () => {
  const { createPermissionBroker, permissionSocketPath } = await import("./claude.ts");
  const { connect, Socket } = await import("node:net");
  const root = mkdtempSync(join(tmpdir(), "broker-no-receipt-"));
  cleanups.push(() => removeTempDir(root));
  const asked: string[] = [];
  const resolved: Array<{ id: string; behavior: string; source: string }> = [];
  const socketPath = process.platform === "win32" ? permissionSocketPath(`broker-receipt-${randomUUID()}`) : join(root, "broker.sock");
  const broker = await createPermissionBroker({ socketPaths: [socketPath],
    onAsk: ask => asked.push(ask.id), onResolve: ask => resolved.push(ask) });
  cleanups.push(() => broker.close());
  const client = connect(broker.socketPath); cleanups.push(() => client.destroy());
  await new Promise<void>((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  client.on("data", () => {});
  const write = Socket.prototype.write;
  // Delay only this exact external answer-write callback. The real broker,
  // retirement state, sockets and retained release checks still execute.
  const held = vi.spyOn(Socket.prototype, "write").mockImplementation(function (this: InstanceType<typeof Socket>, ...args: Parameters<typeof write>) {
    if (String(args[0]).includes('"t":"answer"') && String(args[0]).includes('"id":"retire-held"')) return true;
    return write.apply(this, args);
  });
  cleanups.push(() => held.mockRestore());
  client.write(JSON.stringify({ t: "ask", id: "retire-held", tool: "Bash", input: { command: "echo fixture" } }) + "\n");
  await expect.poll(() => asked).toEqual(["retire-held"]);
  const started = performance.now();
  const retired = broker.nextGeneration();
  expect(broker.answer("retire-held", "allow")).toBe(false);
  expect(broker.settle("retire-held", "allow", undefined, "auto")).toBe(false);
  client.write(JSON.stringify({ t: "ask", id: "late-card", tool: "Bash", input: { command: "echo late" } }) + "\n");
  await retired;
  expect(performance.now() - started).toBeLessThan(1500);
  expect(asked).toEqual(["retire-held"]);
  expect(resolved).toMatchObject([{ id: "retire-held", behavior: "deny", source: "unavailable" }]);
  expect(broker.isPending("retire-held")).toBe(false);
});

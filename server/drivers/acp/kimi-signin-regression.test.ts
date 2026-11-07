import { removeTempDir } from "../../testing/cleanup.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
// Baseline runs load the unchanged historical Kimi shim with the current harness.
const { KimiAgentDriver } = await import(process.env.KIMI_BASE_MODULE || "./kimi.ts");
it.each([
  ["kimi-code-env-0123456789abcdef.json", '{"access_token":"offline-fixture"}', true],
  ["kimi-code.json", '{"access_token":"","refresh_token":""}', false],
])("F30-L1: %s reports the token state", async (name, body, expected) => {
  const home = await mkdtemp(join(tmpdir(), "kimi-regression-"));
  const credentials = join(home, ".kimi-code", "credentials");
  await mkdir(credentials, { recursive: true });
  await writeFile(join(credentials, name as string), body as string);
  vi.stubEnv("KIMI_CODE_HOME", undefined);
  const environment = { HOME: home, USERPROFILE: home };
  const instance = await KimiAgentDriver.create({ instanceId: "kimi-regression", displayName: undefined, enabled: true,
    environment, config: { cli: fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url)), fullAuto: false } });
  try { expect((await instance.snapshot()).authenticated).toBe(expected); }
  finally { vi.unstubAllEnvs(); await instance.dispose(); await removeTempDir(home); }
});

// Characterization guards, not a fix for the parent substitution race.
import { readFile, chmod } from "node:fs/promises";
import { recordEvents } from "../../testing/events.ts";
import { ensureDirs } from "../../config.ts";
import { kimiSignedIn } from "./kimi.ts";
const fakeCli = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const ACCESS = "L9_REG_ACCESS_SENTINEL", REFRESH = "L9_REG_REFRESH_SENTINEL";

it("L9 B4/G6: true, false and unknown attempt identical fresh session/new refusals", async () => {
  ensureDirs(); await chmod(fakeCli, 0o755);
  const home = await mkdtemp(join(tmpdir(), "kimi-traces-"));
  const logs = ["info", "debug", "warn", "error", "log"].map(name => vi.spyOn(console, name as "info").mockImplementation(() => {}));
  const traces: unknown[] = [];
  const refusals: unknown[] = [];
  try {
    for (const [label, body, expected] of [
      ["held", JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, padding: "x".repeat(2357) }), true],
      ["tombstone", '{"access_token":"","refresh_token":""}', false],
      ["unknown", '{}', undefined],
      ["malformed", `{"access_token":"${ACCESS}","padding":"${"b".repeat(6137)}" BROKEN`, false],
    ] as const) {
      const root = join(home, label), dump = join(root, "dump.json"), rpc = join(root, "rpc.jsonl");
      await mkdir(join(root, "credentials"), { recursive: true });
      await writeFile(join(root, "credentials", "kimi-code.json"), body);
      const environment = { HOME: home, USERPROFILE: home, KIMI_CODE_HOME: root, FAKE_ACP_MODE: "auth-required", FAKE_ACP_DUMP: dump, FAKE_ACP_RPC_FULL_LOG: rpc };
      const instance = await KimiAgentDriver.create({ instanceId: "l9-trace", enabled: true, environment, config: { cli: fakeCli, fullAuto: false } });
      const recorder = recordEvents(instance.adapter);
      try {
        const snapshot = await instance.snapshot();
        expect(snapshot.authenticated).toBe(expected);
        expect(snapshot).toEqual({ state: "available", version: expect.any(String), signInAnswerIsLocalHint: true, ...(expected === undefined ? { authUnverified: true } : { authenticated: expected }) });
        const { turnId } = await instance.adapter.sendTurn({ threadId: "l9-trace", text: "offline refusal" });
        await recorder.until(e => e.type === "turn.completed" && e.turnId === turnId);
        expect(recorder.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "runtime.error", message: expect.stringMatching(/auth|sign.in/i) })]));
        refusals.push(recorder.events.filter(e => e.type === "runtime.error").map(e => e.message));
        const protocol = await readFile(rpc, "utf8");
        const trace = protocol.split("\n").filter(Boolean).map(line => JSON.parse(line));
        expect(trace.map(row => row.method)).toEqual(["initialize", "session/new"]);
        traces.push(trace);
        if (process.env.L9_PROTOCOL_EVIDENCE_PATH) await fs.appendFile(process.env.L9_PROTOCOL_EVIDENCE_PATH, JSON.stringify({ label, snapshot, trace, refusal: refusals.at(-1) }) + "\n");
        const exposed = JSON.stringify({ snapshot, protocol, dump: await readFile(dump, "utf8"), events: recorder.events, logs: logs.flatMap(log => log.mock.calls) });
        for (const secret of [ACCESS, REFRESH, ...(body.length > 100 ? [body, String(Buffer.byteLength(body))] : [])]) expect(exposed).not.toContain(secret);
      } finally { recorder.stop(); await instance.dispose(); }
    }
    for (const trace of traces) expect(trace).toEqual(traces[0]);
    for (const refusal of refusals) expect(refusal).toEqual(refusals[0]);
  } finally { logs.forEach(log => log.mockRestore()); await removeTempDir(home); }
});

import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});
it("L9 B5: Stop does not cancel an open scan; expiry is shared until cleanup; a fresh process has no entry", async () => {
  ensureDirs(); await chmod(fakeCli, 0o755);
  const home = await mkdtemp(join(tmpdir(), "kimi-lifecycle-"));
  const credentials = join(home, "credentials"), path = join(credentials, "kimi-code.json");
  await mkdir(credentials);
  const body = JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, padding: "q".repeat(4271) });
  await writeFile(path, body);
  let release!: () => void, reached!: () => void, settled!: () => void;
  const pause = new Promise<void>(resolve => { release = resolve; });
  const opened = new Promise<void>(resolve => { reached = resolve; });
  const done = new Promise<void>(resolve => { settled = resolve; });
  let candidate = false, closed = false, scanStarted = false;
  let expire!: () => void;
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[0] === path) {
      candidate = true;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { closed = true; await close(); });
    }
    return handle;
  });
  const environment = { HOME: home, USERPROFILE: home, KIMI_CODE_HOME: home };
  vi.stubEnv("FAKE_ACP_MODE", "hang");
  const instance = await KimiAgentDriver.create({ instanceId: "l9-life", enabled: true, environment, config: { cli: fakeCli, fullAuto: false } });
  const recorder = recordEvents(instance.adapter);
  const logs = ["debug", "info", "warn", "error", "log"].map(name => vi.spyOn(console, name as "info").mockImplementation(() => {}));
  try {
    const { turnId } = await instance.adapter.sendTurn({ threadId: "l9-life", text: "hang" });
    await recorder.until(e => e.type === "session.started");
    // Control only this deadline; CLI lifecycle timers keep real time on every OS.
    const setTimeout = globalThis.setTimeout;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, ms, ...args) => {
      const timer = setTimeout(callback, ms, ...args);
      if (ms === 60_123) expire = () => { clearTimeout(timer); (callback as () => void)(); };
      return timer;
    }) as typeof globalThis.setTimeout);
    const answer = kimiSignedIn(environment, { deadlineMs: 60_123, settled, pause: async () => { if (candidate) { reached(); await pause; } } });
    timerSpy.mockRestore(); scanStarted = true;
    await opened;
    await instance.adapter.stopAll();
    await recorder.until(e => e.type === "turn.completed" && e.turnId === turnId);
    expect(closed).toBe(false);
    expect(kimiSignedIn(environment)).toBe(answer);
    vi.stubEnv("FAKE_ACP_MODE", "auth-required");
    const next = await instance.adapter.sendTurn({ threadId: "l9-next", text: "refuse" });
    const snapshot = instance.snapshot();
    await recorder.until(e => e.type === "turn.completed" && e.turnId === next.turnId);
    expect(recorder.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "runtime.error", message: expect.stringMatching(/auth|sign.in/i) })]));
    expire();
    expect(await answer).toBeUndefined();
    expect(await snapshot).toMatchObject({ authUnverified: true });
    expect(kimiSignedIn(environment)).toBe(answer);
    expect(await kimiSignedIn(environment)).toBeUndefined();
    expect(closed).toBe(false);
    // A separate server process imports an empty module-local map even while
    // this process still owns its expired, paused entry.
    const fresh = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { kimiSignedIn } from ${JSON.stringify(new URL("./kimi.ts", import.meta.url).href)}; console.log(await kimiSignedIn({KIMI_CODE_HOME:${JSON.stringify(home)}}));`], { encoding: "utf8", timeout: 15_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect(fresh.trim()).toBe("true");
    release(); await done;
    expect(closed).toBe(true);
    expect(kimiSignedIn(environment)).not.toBe(answer);
    expect(await kimiSignedIn(environment)).toBe(true);
    const exposed = JSON.stringify({ events: recorder.events, snapshot: await snapshot, logs: logs.flatMap(log => log.mock.calls), fresh });
    for (const secret of [ACCESS, REFRESH, body, String(Buffer.byteLength(body))]) expect(exposed).not.toContain(secret);
  } finally {
    release(); if (scanStarted) await done; recorder.stop(); await instance.dispose(); vi.unstubAllEnvs(); logs.forEach(log => log.mockRestore());
    vi.mocked(fs.open).mockImplementation(actual.open);
    await removeTempDir(home);
  }
});

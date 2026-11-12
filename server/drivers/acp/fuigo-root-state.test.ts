import { registerBusyloopRequestSite, fluxRouteFor } from "../../../shared/flux-route.ts";
import { isTerminal } from "../../../shared/flux-busyloop.ts";
import { NotModelRequest } from "../../../shared/engine-transport.ts";
import { expect, it, vi } from "vitest";
import { fuigoRootRelocation, fuigoRelocationSeams, FuigoResumeTurn, FUIGO_POLICY_SHA256, fuigoPolicyPath, FuigoPolicyError } from "./fuigo-policy.ts";
const record = { root: "/old", sha256: FUIGO_POLICY_SHA256 };
const raw = { code: -32602, data: { policy_error: "session_policy_conflict", path: fuigoPolicyPath("/new"), message: `this session is governed by ${fuigoPolicyPath("/old")} with a different policy` } };
it.each(["directory", "symlink", "file", "EACCES", "EIO", "ENOENT"])("root itself %s: exactly one lstat, no descendants", kind => {
  const probe = vi.spyOn(fuigoRelocationSeams, "lstat").mockImplementation(() => {
    if (/^E/.test(kind)) throw Object.assign(new Error(kind), { code: kind });
    return {} as ReturnType<typeof fuigoRelocationSeams.lstat>;
  });
  try {
    expect(fuigoRootRelocation(record, ["/old"], "/new")).toEqual({ previous: "/old", copied: kind !== "ENOENT" });
    expect(probe.mock.calls).toEqual([["/old"]]);
  } finally { probe.mockRestore(); }
});
it.each([["/old", []], ["/new", ["/new"]]] as const)("not P: %s in %j never probes", (root, previous) => {
  const probe = vi.spyOn(fuigoRelocationSeams, "lstat");
  try { expect(fuigoRootRelocation({ ...record, root }, [...previous], "/new")).toBeUndefined(); expect(probe).not.toHaveBeenCalled(); }
  finally { probe.mockRestore(); }
});
it("T26a raw classification survives wrapper; T26i new conflict cannot recover", () => {
  const turn = new FuigoResumeTurn({ policy: record, relocation: { previous: "/old", copied: false } }, "/new");
  expect(turn.wrap(raw, "session/load")).toMatchObject({ rootMoved: true });
  expect(turn.wrap(raw, "session/new")).toMatchObject({ rootMoved: false });
  expect(turn.wrap(raw, "session/load")).toBeInstanceOf(FuigoPolicyError);
});
it("M1 copy rejects changed hash before load; current binding loads", () => {
  const relocation = { previous: "/old", copied: true };
  expect(new FuigoResumeTurn({ policy: { ...record, sha256: "bad" }, relocation }, "/new").preflight()).toBe("refuse");
  expect(new FuigoResumeTurn({ policy: { ...record, root: "/new" }, relocation }, "/new").preflight()).toBe("load");
});
it.each(["cancelled", "max_tokens", undefined, "end_turn"])("delivery %s clears only confirmed replay", reason => {
  const delivered = vi.fn();
  const turn = new FuigoResumeTurn({ pending: { cursor: "X" }, delivered });
  expect(turn.needsReplay("X")).toBe(true);
  turn.delivered("X", reason);
  expect(delivered.mock.calls).toEqual(reason === "end_turn" ? [["X"]] : []);
});
it("T26q Y neither replays nor consumes X", () => {
  const delivered = vi.fn(); const pending = { cursor: "X" };
  const turn = new FuigoResumeTurn({ pending, delivered });
  expect(turn.needsReplay("Y")).toBe(false); turn.delivered("Y", "end_turn");
  expect(delivered).not.toHaveBeenCalled(); expect(pending).toEqual({ cursor: "X" });
});

// Run the real core open/recovery block with injected RPCs; no child or network is involved.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transpileModule, ModuleKind } from "typescript";
import { fuigoPolicyFailure, FUIGO_SESSION_POLICY_CONFLICT_LINE } from "./fuigo-policy.ts";
import { openAcpSession } from "./open-session.ts";
const core = readFileSync(new URL("./core.ts", import.meta.url), "utf8");
const openBlockStart = core.indexOf('        const openSession = (');
if (openBlockStart < 0) throw new Error("The core session-open fixture anchor moved");
const openBlock = core.slice(openBlockStart, core.indexOf('        /** support.hostComputerAskedByMurage', openBlockStart));
const recoverBlock = core.slice(core.indexOf('            const cursor = grokBinding ?'), core.indexOf('            proc!.sessionKey = sessionKey;', core.indexOf('            const cursor = grokBinding ?')));
async function coreFixture(options: { context?: ConstructorParameters<typeof FuigoResumeTurn>[0]; loadError?: unknown; newError?: unknown; calls?: string[] } = {}) {
  const calls: string[] = options.calls ?? []; const events: unknown[] = []; const warnings: string[] = []; const received: unknown[] = [];
  const fuigoResume = new FuigoResumeTurn(options.context, "/new");
  const js = transpileModule(`(async () => {
    let sessionResult, sessionId = null, promptTurn;
    ${openBlock}
    ${recoverBlock}
    return { sessionId, promptTurn, renewed: fuigoResume.renewed };
  })()`, { compilerOptions: { target: 99, module: ModuleKind.ESNext } }).outputText;
  const result = await runInNewContext(js, {
    fuigoResume, FuigoPolicyError, FUIGO_SESSION_POLICY_CONFLICT_LINE,
    // ac1264dc5 moved openSession's body into open-session.ts (core.ts imports openAcpSession); the extracted block calls it, so the sandbox gets the real one.
    // 8d507d1c7 passes the process's owner binding into openAcpSession: with no process in this fixture there is none.
    openAcpSession, modelControls: { receive: (answer: unknown) => { received.push(answer); } }, proc: undefined,
    env: {}, NotModelRequest,
    // core.ts declares DestinationRefusal at module scope (line 7); the extracted block's rethrowPolicyFailure tests `instanceof` it, so the sandbox needs a class of that name.
    DestinationRefusal: class DestinationRefusal extends Error {},
    // openSession's Flux destination check on session/load reads these two turn variables; with no effective-destination answer (a Fuigo turn) it is skipped.
    effectiveAnswer: undefined, effectiveHeaders: false,
    // the real transport hands each successful answer to its receive callback (the 7th argument) before the next frame; openAcpSession binds the ID there
    request: async (method: string, _params?: unknown, _timeout?: unknown, _a?: unknown, _b?: unknown, _c?: unknown, receive?: (answer: unknown) => void) => {
      calls.push(method); const error = method === "session/load" ? options.loadError : options.newError; if (error) throw error;
      const answer = { sessionId: method === "session/load" ? "old" : "replacement" }; receive?.(answer); return answer;
    },
    sessionParams: (p: unknown) => p, sessionOpened: (r: unknown) => r,
    support: { driverKind: "fuigoAgent", policyFailure: fuigoPolicyFailure },
    externalHalt: () => false, settleHalted: () => {}, grokBinding: null, resumeId: "old", reloadCursor: "old", turn: { transcript: [{ role: "user", text: "AUTHORIZED" }] },
    replayTurn: (prefix: string) => `${prefix} AUTHORIZED`,
    cwd: "/fixture", mcpServers: [], LOAD_SESSION_TIMEOUT: 1, NEW_SESSION_TIMEOUT: 1,
    threadId: "thread", turnId: "turn", base: () => ({}), emit: (e: unknown) => events.push(e),
    console: { warn: (s: string) => warnings.push(s) },
    sessionOpenElsewhere: () => false, loadRefusal: (error: unknown) => { throw new Error(`must skip loadRefusal; reached with: ${error instanceof Error ? error.stack : String(error)}`); },
  });
  return { result, calls, events, warnings, received };
}
it("T26a core recovery skips refusal, emits notice, opens new and replays", async () => {
  const got = await coreFixture({ context: { policy: record, relocation: { previous: "/old", copied: false } }, loadError: raw });
  expect(got.calls).toEqual(["session/load", "session/new"]);
  expect(got.result).toMatchObject({ sessionId: "replacement", renewed: true });
  expect(got.result.promptTurn).toContain("AUTHORIZED");
  expect(got.events).toContainEqual(expect.objectContaining({ title: "Picked up this conversation in a fresh session" }));
  expect(got.warnings).toEqual(["fuigo-session-renewed reason=data-root-moved thread=thread"]);
  // the failed load never reached receive; only the replacement session's answer did
  expect(got.received).toEqual([{ sessionId: "replacement" }]);
});
it.each([false, true])("T26m core copy preflight, recorded=%s, never loads", async recorded => {
  const got = await coreFixture({ context: { policy: recorded ? record : undefined, relocation: { previous: "/old", copied: true } } });
  expect(got.calls).toEqual(["session/new"]); expect(got.result.promptTurn).toContain("AUTHORIZED");
  expect(got.result).toMatchObject({ sessionId: "replacement", renewed: true }); expect(got.received).toEqual([{ sessionId: "replacement" }]);
});
it("T26i core new conflict stops after load then new", async () => {
  const calls: string[] = [];
  await expect(coreFixture({ calls, context: { policy: record, relocation: { previous: "/old", copied: false } }, loadError: raw, newError: raw })).rejects.toThrow(FUIGO_SESSION_POLICY_CONFLICT_LINE);
  expect(calls).toEqual(["session/load", "session/new"]);
});
it("T26c core conflicting moved legacy keeps calm line", async () => {
  await expect(coreFixture({ context: { relocation: { previous: "/old", copied: false } }, loadError: raw })).rejects.toThrow(FUIGO_SESSION_POLICY_CONFLICT_LINE);
});
it("T26l core legacy move loads; T26n current copy loads", async () => {
  for (const policy of [undefined, { ...record, root: "/new" }]) {
    const got = await coreFixture({ context: { policy, relocation: { previous: "/old", copied: !!policy } } });
    expect(got.calls).toEqual(["session/load"]); expect(got.events).toEqual([]); expect(got.result.promptTurn).toBeUndefined();
    expect(got.result).toMatchObject({ sessionId: "old", renewed: false }); expect(got.received).toEqual([{ sessionId: "old" }]);
  }
});

it.each([10, 10000])("M3 dispatch reads one policy slot with %s tasks; no enumeration", size => {
  let reads = 0;
  const noScan = { ownKeys: () => { throw new Error("enumeration forbidden"); } };
  const tasks = new Proxy(Array(size), noScan);
  const policies = new Proxy({ fuigo: record }, noScan);
  const task = { get resumePolicies() { reads++; return policies; } };
  const index = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
  const line = index.split("\n").find(line => line.includes('const fuigoPolicy = instance.driverKind'))!;
  expect(runInNewContext(`${line}\nfuigoPolicy`, { task, tasks, instanceId: "fuigo", instance: { driverKind: "fuigoAgent" } })).toEqual(record);
  expect(reads).toBe(1);
});

import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { removeTempDirSync } from "../../testing/cleanup.ts";
it.each(["symlink", "file"])("real root replaced by %s is copied without following or reading it", kind => {
  const dir = mkdtempSync(join(tmpdir(), "fuigo-root-"));
  try {
    const root = join(dir, "previous");
    if (kind === "symlink") symlinkSync(join(dir, "does-not-exist"), root);
    else writeFileSync(root, "not a directory");
    expect(fuigoRootRelocation({ ...record, root }, [root], join(dir, "current"))).toEqual({ previous: root, copied: true });
  } finally { removeTempDirSync(dir); }
});

it.each(["end_turn", "cancelled", "max_tokens", "reject"])("T26o/p core waits for delivery (%s), never clears on send", async reason => {
  const delivered = vi.fn();
  const fuigoResume = new FuigoResumeTurn({ pending: { cursor: "X" }, delivered });
  let resolve!: (r: unknown) => void; let reject!: (e: Error) => void;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  const start = core.indexOf('            const promptIdleMs = acpPromptIdleTimeoutMs();'); // the request and what follows it in the same tick (the writer flips promptSent with the bytes)
  const sent = core.slice(start, core.indexOf('            if (stackKey', start));
  const end = core.indexOf('            const reason = result?.stopReason;', start);
  const completed = core.slice(end, core.indexOf('            // Flushed here', end));
  const js = transpileModule(`(async () => { ${sent}\n${completed} })()`, { compilerOptions: { target: 99 } }).outputText;
  const pending = runInNewContext(js, {
    state: { promptSent: true }, quiet: undefined, turnTrace: () => ({ once() {} }), threadId: "t", promptStartedAt: 0, Date,
    DRIVER_KIND: "fuigoAgent", startFuigoWatch() {}, acpPromptIdleTimeoutMs: () => 1,
    request: () => response, sessionId: "X", text: "history", turn: {}, support: {},
    ENGINE: "Fuigo", plainDuration: () => "one second", acpToolMaxMs: () => 1,
    notePromptSent() {}, fuigoResume,
    registerBusyloopRequestSite, fluxRouteFor, requestUrl: undefined, fluxRoutedTurn: false, isTerminal,
  });
  expect(delivered).not.toHaveBeenCalled();
  if (reason === "reject") { reject(new Error("child exited or rejected")); await expect(pending).rejects.toThrow("child exited"); }
  else { resolve({ stopReason: reason }); await pending; }
  expect(delivered.mock.calls).toEqual(reason === "end_turn" ? [["X"]] : []);
});

it("T26j core records pending before setup failure and next load replays", async () => {
  const fuigoResume = new FuigoResumeTurn(); fuigoResume.renewed = true;
  const events: Array<{ sessionId: string; replayPending?: boolean }> = [];
  const start = core.indexOf('            let selectedModel: string | null = null;');
  const block = core.slice(start, core.indexOf('            // A stop while the session was being set up', start));
  const js = transpileModule(`(async () => { ${block} })()`, { compilerOptions: { target: 99 } }).outputText;
  await expect(runInNewContext(js, {
    fuigoResume, sessionId: "replacement", grokBinding: null, threadId: "thread", turnId: "turn", base: () => ({}),
    emit: (e: typeof events[number]) => events.push(e), support: { configureSession: async () => { throw new Error("setup failed"); } },
    sessionResult: {}, turnConfig: {}, cliTurn: {}, env: {}, turnHalted: () => false,
    // d121dae1e: the block now also asks whether this turn resumed a session (a fresh one, here) before resetting a thinking variant.
    resumeId: undefined,
    // the fence and state of an unstopped send: admits everything, nothing sent yet (the unfenced product path)
    fence: { live: () => true, retired: () => false, check() {}, handedOff: false }, state: { promptSent: false, settled: false, stopRequested: false, cancelRequested: false },
  })).rejects.toThrow("setup failed");
  expect(events).toEqual([expect.objectContaining({ sessionId: "replacement", replayPending: true })]);
  const next = new FuigoResumeTurn({ pending: events[0].replayPending ? { cursor: events[0].sessionId } : undefined });
  const replayStart = core.indexOf('            if (fuigoResume?.needsReplay(sessionId)');
  const replay = core.slice(replayStart, core.indexOf("            // the owner's session is now known:", replayStart));
  const replayJs = transpileModule(`let promptTurn; ${replay}\npromptTurn`, { compilerOptions: { target: 99 } }).outputText;
  expect(runInNewContext(replayJs, { fuigoResume: next, sessionId: "replacement", turn: { transcript: ["history"] }, replayTurn: (p: string) => p + " history" })).toContain("history");
});
it("T26-multiroot legacy cursor with several previous roots fails closed: no root picked, no probe, calm line, no fresh session", async () => {
  const probe = vi.spyOn(fuigoRelocationSeams, "lstat");
  try {
    expect(fuigoRootRelocation(undefined, ["/old", "/older"], "/new")).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  } finally { probe.mockRestore(); }
  const calls: string[] = [];
  await expect(coreFixture({ calls, context: {}, loadError: raw })).rejects.toThrow(FUIGO_SESSION_POLICY_CONFLICT_LINE);
  expect(calls).toEqual(["session/load"]);
});

it("M3 no site in index.ts reaches the policy or pending maps through a scan, and the dispatch window has no task scan", () => {
  const lines = readFileSync(new URL("../../index.ts", import.meta.url), "utf8").split("\n");
  const scan = /\.(find|filter|map|some|every|flatMap|reduce|forEach)\(|\bfor \(|Object\.(entries|values|keys)\(|\.\.\.tasks|\.iterate\(|\.all\(/;
  const sites = lines.map((text, i) => ({ text, n: i + 1 })).filter(l => /resumePolicies|replayPending|fuigoRootRelocation|previousRoots\(/.test(l.text) && !/^\s*(\/\/|\*)/.test(l.text));
  expect(sites.length).toBeGreaterThan(2);
  for (const site of sites) if (!/const (wireTask|\{ permissionPrev)|_resumePolicies/.test(site.text)) expect(site.text, "index.ts:" + site.n).not.toMatch(scan);
  const at = lines.findIndex(l => l.includes("const fuigoPolicy = instance.driverKind"));
  const window = lines.slice(at - 4, at + 3).join("\n");
  expect(window).not.toMatch(scan);
});

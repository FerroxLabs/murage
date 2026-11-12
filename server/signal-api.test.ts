// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "./testing/cleanup.ts";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { requireCommittedG0 } from "./channels/signal/g0-test-fixtures.ts";
import { z } from "zod";
import { signalActionFailure } from "./channels/signal/action-error.ts";
import { expect, it, vi } from "vitest";
import { loadSignalAdapters } from "./channels/signal/adapters.ts";
import type { RuntimePin, SignalService } from "./channels/signal/types.ts";
import type { SignalServiceOptions } from "./channels/signal/service.ts";
import { SignalService as RealSignalService } from "./channels/signal/service.ts";
import type { HostEvent } from "./channels/signal/process-host.ts";

// Execute the production route adapter with an isolated service fixture, without
// importing index.ts's startup or ever constructing a Signal child.
function routeFixture() {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const code = source.match(/\/\/ B8 route adapter start\n([\s\S]*?)\/\/ B8 route adapter end/)?.[1];
  expect(code, "Signal route adapter exists").toBeTruthy();
  const js = ts.transpileModule(code!, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const route = new Function("z", "signalActionFailure", `${js}; return signalRoute;`)(z, signalActionFailure);
  const service: SignalService = { status: vi.fn<SignalService["status"]>(() => ({ state: "not-linked" })), link: vi.fn(async () => ({ state: "not-linked" as const })),
    disconnect: vi.fn(async () => ({ state: "not-linked" as const })), resend: vi.fn(async () => "resent" as const), settle: vi.fn(async () => {}),
    retryNotes: vi.fn(async () => {}), finishRevocation: vi.fn(async () => ({ state: "not-linked" as const })), fixPermissions: vi.fn(async () => ({ state: "not-linked" as const })) };
  const context = { enabled: true, owner: true, closing: false, chiefBotId: "chief", service, openInMurage: vi.fn(() => null) };
  return { service, context, request: (path: string, body: unknown = {}, method = "POST") => route(`/api/signal/${path}`, method, body, context) };
}
it("T-NO-SURFACE / T-CLOUD: activation and owner guards independently refuse an otherwise valid status read", async () => {
  const { service, context, request } = routeFixture();
  expect((await request("status", {}, "GET")).status).toBe(200);
  context.enabled = false; expect((await request("status", {}, "GET")).status).toBe(404);
  context.enabled = true; context.owner = false; expect((await request("status", {}, "GET")).status).toBe(404);
  expect(service.status).toHaveBeenCalledOnce();
});
it("T-LINK: uses the current Chief, rejects another Chief and extra fields before service calls", async () => {
  const { service, context, request } = routeFixture();
  expect((await request("link")).status).toBe(200); expect(service.link).toHaveBeenCalledWith({ chiefBotId: "chief" });
  expect((await request("link", { chiefBotId: "other" })).status).toBe(409);
  expect((await request("link", { recipient: "stranger" })).status).toBe(400);
  context.closing = true; expect((await request("link")).status).toBe(409); expect(service.link).toHaveBeenCalledOnce();
});
it("T-RESEND / T-RL-DEADLINE: the route preserves full and cooldown outcomes and never settles before resend", async () => {
  const { service, request } = routeFixture(); const deliveryId = "a".repeat(64);
  for (const result of ["resent", "already", "full", "too-early", "not-resendable"] as const) {
    vi.mocked(service.resend).mockResolvedValue(result);
    const response = await request("resend", { deliveryId });
    expect(response.body.result).toBe(result); expect(response.status).toBe(["resent", "already", "full"].includes(result) ? 200 : 409);
  }
  expect(service.settle).not.toHaveBeenCalled();
  expect((await request("resend", { deliveryId, response: "forged" })).status).toBe(400);
  for (const action of ["leave-it", "dismiss"]) expect((await request(action, { deliveryId })).status).toBe(200);
  expect(service.settle).toHaveBeenCalledTimes(2);
});
it("T-RECOVERY: recovery actions delegate to B7 and expose only fixed error copy", async () => {
  const { service, request } = routeFixture();
  for (const [path, fn] of [["disconnect", service.disconnect], ["finish-revocation", service.finishRevocation], ["fix-permissions", service.fixPermissions], ["retry-notes", service.retryNotes]] as const) {
    expect((await request(path)).status).toBe(200); expect(fn).toHaveBeenCalledOnce();
  }
  vi.mocked(service.disconnect).mockRejectedValue(Error("private canary"));
  expect(JSON.stringify(await request("disconnect"))).not.toContain("canary");
});

it.each(["disconnect", "finish-revocation", "fix-permissions", "retry-notes", "leave-it", "show-folder"])("Signal %s reports a permission failure plainly and logs only its cause", async action => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { service, context, request } = routeFixture();
    const fail = vi.fn(async () => { throw Object.assign(new Error("private Signal evidence canary"), { code: "EPERM" }); });
    const methods = { disconnect: "disconnect", "finish-revocation": "finishRevocation", "fix-permissions": "fixPermissions", "retry-notes": "retryNotes", "leave-it": "settle" } as const;
    if (action === "show-folder") Object.assign(context, { showFolder: fail });
    else Object.assign(service, { [methods[action as keyof typeof methods]]: fail });
    const answer = await request(action, action === "leave-it" ? { deliveryId: "a".repeat(64) } : {});
    expect(answer).toEqual({ status: 409, body: { error: "Murage does not have permission to change the Signal files on this computer." } });
    expect(warn).toHaveBeenCalledExactlyOnceWith("[signal] action failed:", action, "EPERM");
    expect(JSON.stringify([answer, warn.mock.calls])).not.toContain("canary");
  } finally { warn.mockRestore(); }
});

it.each([
  ["ENOSPC", "There is no room on this disk to save the Signal changes."],
  ["EROFS", "This disk is read-only, so Murage cannot save the Signal changes."],
  ["EBUSY", "The Signal files are in use. Close the other process and try again."],
  ["offline", "Signal is not connected. Connect again in Signal settings."],
  ["timeout", "Signal took too long to answer. Try again in Signal settings."],
])("Signal settings keep the real %s cause without returning raw error text", async (code, message) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { service, request } = routeFixture();
    vi.mocked(service.disconnect).mockRejectedValue(Object.assign(new Error("private evidence canary"), { code }));
    expect(await request("disconnect")).toEqual({ status: 409, body: { error: message } });
    expect(warn).toHaveBeenCalledExactlyOnceWith("[signal] action failed:", "disconnect", code);
  } finally { warn.mockRestore(); }
});

it("Signal reports a kept-file hold separately, and logs an unknown error without leaking it", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { service, request } = routeFixture();
    vi.mocked(service.disconnect).mockRejectedValue(Object.assign(new Error("private hold canary"), { reason: "durability" }));
    expect((await request("disconnect")).body.error).toBe("Murage cannot confirm the Signal changes were saved. Open Murage again before linking Signal.");
    expect(warn).toHaveBeenLastCalledWith("[signal] action failed:", "disconnect", "durability");
    vi.mocked(service.disconnect).mockRejectedValue(new Error("Signal files are kept"));
    expect((await request("disconnect")).body.error).toBe("Murage kept your Signal files. Review the connection in Signal settings before trying again.");
    vi.mocked(service.disconnect).mockRejectedValue(Object.assign(new Error("private evidence canary"), { code: "PRIVATE_CANARY" }));
    const unknown = await request("disconnect");
    expect(unknown.status).toBe(409);
    expect(warn).toHaveBeenLastCalledWith("[signal] action failed:", "disconnect", "error");
    expect(JSON.stringify([unknown, warn.mock.calls])).not.toMatch(/canary|PRIVATE/);
  } finally { warn.mockRestore(); }
});

function wiringFixture(fixtureDirectory?: string, pinOverride?: RuntimePin) {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("// B4 normalization"), source.indexOf("// B8 route adapter start"));
  expect(code).toContain("function makeSignal");
  const js = ts.transpileModule(code.replaceAll("import.meta.dirname", '"/fixture/server"').replaceAll("import.meta.url", '"file:///fixture/server/index.ts"'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  let options!: SignalServiceOptions, cloud = false;
  let hostEvent!: (event: HostEvent) => void;
  const binding = { connectionId: "fixture", generation: 1, ownAci: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ownDeviceId: 2, linkedAt: 1, chiefBotId: "chief" };
  const host = { generation: 1, spawnToken: Symbol("fixture"), identity: { ownAci: binding.ownAci, ownDeviceId: 2 } };
  const pin = { signalCliVersion: "fixture", g0: { signalCliVersion: "fixture", citation: "fixture" }, signalNetwork: { syncProof: {} } };
  const runs = [{ id: "run", botId: "chief", channelOrigin: { platform: "signal", connectionId: "fixture" }, humanPrincipal: {}, status: "running", output: "reply" },
    { id: "other", botId: "chief", channelOrigin: { platform: "signal", connectionId: "other" }, status: "running" }];
  const routines = { findWebhookDelivery: vi.fn(() => null), activeWebhookRunCount: () => 0, enqueueWebhook: vi.fn(() => ({ id: "run" })),
    listRuns: () => runs, closeEventBudget: vi.fn(), cancelRun: vi.fn(async () => {}) };
  const observe = vi.fn(() => "owner-binding"), link = vi.fn(), revoke = vi.fn();
  const deps = {
    SignalService: class { constructor(value: SignalServiceOptions) { options = value; } },
    SignalProcessHost: class { constructor(options: { onEvent: (event: HostEvent) => void }) { hostEvent = options.onEvent; return host; } },
    SignalTransport: class {}, createSignalStorageGuard: vi.fn(), verifyRuntimePin: vi.fn(),
    DATA_DIR: "/fixture/data", join: (...parts: string[]) => parts.join("/"),
    signalRuntimePin: pinOverride ?? pin, bootSignalRuntime: ({ pin: p }: { pin: RuntimePin }) => ({ runtimeDir: "/fixture/runtime", fixtureDir: fixtureDirectory,
      adapters: loadSignalAdapters(p, fixtureDirectory ?? "/missing-synthetic-evidence") }), isCloudHome: () => cloud, store: { workspaceChief: () => ({ id: "chief" }), bot: () => ({}) },
    homeExecutionGate: { channelsOpen: vi.fn(() => true) }, routines,
    observeVerifiedHuman: observe, humanBindingStatus: () => ({ bindings: [{ id: "owner-binding", revision: 3, personId: null }] }),
    ownerMemoryTicket: () => "ticket", WORKSPACE_OWNER: "owner", linkHumanBinding: link, revokeHumanConnection: revoke,
    resolveHumanDelivery: vi.fn(() => ({ personId: "owner" })), assertHumanPrincipal: vi.fn(),
    channelReplyText: (_: unknown, text: string) => text, redactSecretsInText: (text: string) => text,
    channelLimitNotice: () => undefined, isOpenRoutineRunStatus: (status: string) => status === "running",
  };
  const setup = new Function("deps", "binding", `const { ${Object.keys(deps).join(",")} } = deps;
    let signal = { status: () => ({ state: "linked", binding }) }, signalBinding, signalHost, signalReadyToken;
    let dataWritersStopped = false, signalCustodyHeld = false, signalAuthorityReplayHeld=false; const signalParkVerdict = { state: "ready" };
    ${js}
    return { makeSignal, signalAdapters: signalBoot.adapters, signalEnabled, signalBindingCurrent, close: () => { dataWritersStopped = true; } };`)(deps, binding);
  return { ...setup, pin, host, binding, deps, routines, observe, link, revoke, options: () => options, cloud: () => { cloud = true; },
    ready: () => hostEvent({ kind: "ready", generation: 1, spawnToken: host.spawnToken, identity: { ...host.identity, number: "+15550001234" } }) };
}
it("T-CLOUD / T-NO-SURFACE: activation needs the matching pin and verified adapters; default access admits nothing", () => {
  const f = wiringFixture();
  expect(f.signalEnabled()).toBe(false);
  expect(f.signalAdapters.access.parse({ text: "unproven" })).toBeNull();
  expect(f.signalAdapters.access.decide({} as never, {} as never)).toBe("drop");
  expect(f.signalAdapters.access.control({} as never, {} as never)).toBe(false);
  f.signalAdapters.verified = true; f.signalAdapters.linkProtocol = {}; expect(f.signalEnabled()).toBe(true);
  f.pin.g0.signalCliVersion = "other"; expect(f.signalEnabled()).toBe(false);
  f.pin.g0.signalCliVersion = "fixture"; expect(f.signalEnabled()).toBe(true);
  f.signalAdapters.verified = false; expect(f.signalEnabled()).toBe(false);
  f.signalAdapters.verified = true;
  f.cloud(); expect(f.signalEnabled()).toBe(false);
});
it("T-WIRING: links the verified owner, fences turns, scopes results and revokes only this connection", async () => {
  const f = wiringFixture(); f.signalAdapters.verified = true; f.signalAdapters.linkProtocol = {};
  f.makeSignal(); const options = f.options();
  options.host({ expectedIdentity: () => f.binding, onEvent: () => {}, isIdle: () => true });
  expect(f.signalBindingCurrent(f.binding)).toBe(false); f.ready(); expect(f.signalBindingCurrent(f.binding)).toBe(true);
  await options.people.linkOwner(f.binding);
  expect(f.observe).toHaveBeenCalledWith({ platform: "signal", authorityId: f.binding.ownAci, userId: f.binding.ownAci, connectionId: "fixture" });
  expect(f.link).toHaveBeenCalledWith("ticket", { bindingId: "owner-binding", expectedRevision: 3, as: "owner" });
  const runs = options.runs({ binding: f.binding, channelOrigin: { platform: "signal", connectionId: "fixture" },
    owner: { platform: "signal", authorityId: f.binding.ownAci, userId: f.binding.ownAci, connectionId: "fixture" }, notOwnerAudience: false });
  expect(runs.enqueue({ deliveryId: "note", prompt: "wrapped" })).toEqual({ id: "run" });
  expect(f.routines.enqueueWebhook.mock.calls[0][0]).toMatchObject({ botId: "chief", channelOrigin: { platform: "signal", connectionId: "fixture" }, humanPrincipal: { personId: "owner" } });
  expect(f.routines.enqueueWebhook.mock.calls[0][0]).not.toHaveProperty("notOwnerAudience");
  expect(runs.result("run")).toMatchObject({ output: "reply" }); expect(runs.result("other")).toBeNull();
  f.host.spawnToken = Symbol("respawn"); expect(f.signalBindingCurrent(f.binding)).toBe(false);
  f.ready(); expect(f.signalBindingCurrent(f.binding)).toBe(true);
  f.host.generation = 2; expect(() => runs.enqueue({ deliveryId: "note2", prompt: "wrapped" })).toThrow();
  expect(f.routines.enqueueWebhook).toHaveBeenCalledOnce();
  await options.revokeRuns("fixture"); expect(f.routines.cancelRun).toHaveBeenCalledExactlyOnceWith("run");
  await options.people.revoke("fixture"); expect(f.revoke).toHaveBeenCalledExactlyOnceWith("signal", "fixture");
});
it("T-INVENTORY: every route, B0 problem and action has exactly one surface declaration", () => {
  const inventory = JSON.parse(readFileSync(new URL("./channels/signal/signal.inventory.json", import.meta.url), "utf8")).surfaces;
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ui = readFileSync(new URL("../src/components/SignalSettings.tsx", import.meta.url), "utf8");
  const keys = inventory.map((row: { kind: string; id: string }) => `${row.kind}:${row.id}`);
  expect(new Set(keys).size).toBe(keys.length);
  for (const [, route] of index.matchAll(/"(\/api\/signal\/[a-z-]+)"/g)) expect(keys).toContain(`route:${route}`);
  const types = readFileSync(new URL("./channels/signal/types.ts", import.meta.url), "utf8");
  for (const [, problem] of types.match(/export type SignalProblem\s*=([\s\S]*?);/)![1].matchAll(/"([^"]+)"/g)) expect(keys).toContain(`problem:${problem}`);
  const actions = types.match(/export type SignalAction\s*=([\s\S]*?)export type RpcId/)![1];
  for (const [, fields] of actions.matchAll(/\{([^}]+)\}/g)) {
    const union = fields.match(/action:\s*((?:"[^"]+"\s*(?:\|\s*)?)+)/)![1];
    for (const [, id] of union.matchAll(/"([^"]+)"/g)) expect(keys).toContain(`${/\bdeliveryId\s*:/.test(fields) ? "review" : "recovery"}:${id}`);
  }
  for (const row of inventory) { expect(row.why).not.toMatch(/[\r\n]/); if (row.path.endsWith("SignalSettings.tsx")) expect(ui).toContain(row.id); }
});
it("T-RL-DEADLINE / T-RESEND: the route uses B7's persisted cooldown after restart, then creates one replacement", async () => {
  const home = mkdtempSync(join(tmpdir(), "signal-b8-route-"));
  const aci = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", deliveryId = "a".repeat(64), token = Symbol("fixture");
  let now = 1800000000000, event!: (event: HostEvent) => void, service: RealSignalService | undefined;
  const binding = { connectionId: "fixture", generation: 1, ownAci: aci, ownDeviceId: 2, linkedAt: now - 1000, chiefBotId: "chief" };
  const put = (file: string, value: unknown) => { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); };
  const file = join(home, "channels/signal/fixture/receipts.json");
  put(join(home, "channels/signal/connection.json"), { version: 1, connectionId: "fixture", generation: 1, enabled: true, paused: false, revoking: false, binding, account: "+15550001234" });
  put(file, { version: 1, bindingKey: "fixture", recipient: `note-to-self:${createHash("sha256").update(aci).digest("hex")}`, tombstones: [],
    records: [{ deliveryId, occurredAt: now, prompt: "fixture note", response: "fixture answer", attempts: 1, state: "uncertain", expiryKnown: true, resendAfter: now + 60000 }] });
  const send = vi.fn(async () => { throw Error("No sending in this fixture"); });
  const options: SignalServiceOptions = {
    dataDir: home, now: () => now, channelsOpen: () => true, isCloudHome: () => false, isCurrentChief: () => true,
    storage: () => ({ check: async () => ({ state: "ok" }), repair: async () => ({ state: "ok" }) }),
    access: { parse: () => null, decide: () => "drop", control: () => false },
    host: context => { event = context.onEvent; return {
      generation: 1, spawnToken: token, identity: { ownAci: aci, ownDeviceId: 2, number: "+15550001234" },
      spawn: async () => { event({ kind: "ready", generation: 1, spawnToken: token, identity: { ownAci: aci, ownDeviceId: 2, number: "+15550001234" } }); },
      request: async () => { throw Error("No RPC in this fixture"); }, onNotification: () => () => {}, stop: async () => {}, pauseReading() {}, resumeReading() {},
    }; },
    transport: () => ({ reserve: async () => [], sendNoteToSelf: send }),
    runs: () => ({ enqueue: () => ({ id: "fixture-run" }), result: () => ({ status: "running" }) }),
    people: { linkOwner: async () => {}, revoke: async () => {} }, revokeRuns: async () => {},
  };
  const f = routeFixture();
  try {
    service = new RealSignalService(options); await service.start(); f.context.service = service;
    expect((await f.request("resend", { deliveryId })).body.result).toBe("too-early");
    await service.stop(); service = new RealSignalService(options); await service.start(); f.context.service = service;
    expect((await f.request("resend", { deliveryId })).body.result).toBe("too-early");
    now += 60000;
    expect((await f.request("resend", { deliveryId })).body.result).toBe("resent");
    expect((await f.request("resend", { deliveryId })).body.result).toBe("already");
    const records = JSON.parse(readFileSync(file, "utf8")).records;
    expect(records).toHaveLength(2); expect(records.find((row: { deliveryId: string }) => row.deliveryId === deliveryId)).toMatchObject({ state: "cancelled", error: "reviewed", prompt: "" });
    expect(records.find((row: { deliveryId: string }) => row.deliveryId !== deliveryId).response).toBe("fixture answer");
    expect(send).not.toHaveBeenCalled();
  } finally { await service?.stop(); removeTempDirSync(home); }
});
it("T-CONTRACTS: B8 wiring and renderer type-check against the read-only service and scheduler APIs", () => {
  const root = fileURLToPath(new URL("../", import.meta.url)), fixture = join(root, "server/signal-b8-contract-fixture.ts");
  const index = readFileSync(join(root, "server/index.ts"), "utf8");
  const wiring = index.slice(index.indexOf("// B4 normalization"), index.indexOf("// B8 route adapter end"));
  const source = `
    import { join } from "node:path";
    import { ParkFs } from "./channels/signal/park-fs.ts";
    import { readControl, readConnection } from "./channels/signal/park-control.ts";
    import { assertSignalLinkAllowed, enumerateSignalBundles, type ParkVerdict } from "./channels/signal/park.ts";
    import type { SignalLocalAuthority } from "./channels/signal/park-replacement.ts";
    declare let signalParkVerdict: ParkVerdict;
    declare function makeSignalHold(): SignalServiceContract;
    declare function hasEarlierSignalAuthority(routines: RoutineManager, currentId?:string): boolean;
    import { SignalParkError } from "./channels/signal/park-fs.ts";
    declare let signalCustodyHeld: boolean, signalAuthorityReplayHeld: boolean;
    declare function signalLocalAuthority(): SignalLocalAuthority;
    declare function signalReplacementInProgress(root:string): boolean;
    import { bootSignalRuntime } from "./channels/signal/boot.ts";
    import { z } from "zod";
import { signalActionFailure } from "./channels/signal/action-error.ts";
    import { SignalService, type SignalServiceOptions, type SignalAccess, type SignalLinkProtocol, type ServiceHost } from "./channels/signal/service.ts";
    import { SignalProcessHost, verifyRuntimePin } from "./channels/signal/process-host.ts";
    import { createSignalStorageGuard } from "./channels/signal/storage.ts";
    import { SignalTransport } from "./channels/signal/transport.ts";
    import type { SignalBinding, SignalService as SignalServiceContract, RuntimePin } from "./channels/signal/types.ts";
    import signalRuntimePin from "./channels/signal/runtime-pin.json";
    import { WORKSPACE_OWNER, humanBindingStatus, linkHumanBinding, observeVerifiedHuman, revokeHumanConnection, resolveHumanDelivery, assertHumanPrincipal } from "./human-principals.ts";
    import { ownerMemoryTicket } from "./memory/authority.ts";
    import { channelReplyText } from "./draft-only.ts";
    import { redactSecretsInText } from "./redact.ts";
    import { isOpenRoutineRunStatus, type RoutineManager, type RoutineRun } from "./routines.ts";
    import type { Store } from "./store.ts";
    declare const DATA_DIR: string, dataWritersStopped: boolean, store: Store, routines: RoutineManager | undefined;
    declare const homeExecutionGate: { channelsOpen(channel: "signal"): boolean } | undefined;
    declare function isCloudHome(): boolean;
    declare function channelLimitNotice(run: RoutineRun): string | undefined;
    declare let signal: SignalServiceContract | undefined, signalBinding: SignalBinding | undefined, signalHost: ServiceHost | undefined, signalReadyToken: symbol | undefined;
    ${wiring}
  `;
  const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options = { ...parsed.options, noUnusedLocals: false, noUnusedParameters: false };
  const host = ts.createCompilerHost(options), originalRead = host.readFile, originalExists = host.fileExists;
  host.readFile = file => file === fixture ? source : originalRead(file);
  host.fileExists = file => file === fixture || originalExists(file);
  const ui = join(root, "src/components/SignalSettings.tsx");
  const program = ts.createProgram([fixture, ui, ...parsed.fileNames.filter(file => file.endsWith(".d.ts"))], options, host);
  const diagnostics = [fixture, ui].flatMap(file => {
    const sf = program.getSourceFile(file)!; return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
  });
  const messages=diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  expect(messages,messages.join("\n")).toEqual([]);
}, 60000);

it("T-WIRING: every declared Signal route has an explicit desktop credential policy", async () => {
  const { routePolicy, cloudRouteDecision } = await import("./route-policy.ts");
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const routes = [...source.matchAll(/"(\/api\/signal\/[^"\n]+)": "(GET|POST)"/g)];
  expect(routes).toHaveLength(14);
  for (const [, path, method] of routes) {
    expect(routePolicy(method, path), `explicit credential policy for ${method} ${path}`).toMatchObject({ class: "desktop", cloudWrite: "credential" });
    if (method === "POST") expect(cloudRouteDecision(method, path, "owner-phone", {}, true)).toBe("deny");
  }
});


it("T-STARTUP: Signal modules load under the server's native Node strip-types runtime", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    "await import('./server/channels/signal/service.ts'); await import('./server/channels/signal/process-host.ts');"],
    { cwd: root, encoding: "utf8", timeout: 30000 });
  expect(result.status, result.stderr).toBe(0);
});

// Native child keeps the verification launcher outside Vitest's module loader.
// The launcher owns an isolated HOME/dataDir and closes its exact child.
function isolatedSignalStatus(expected: number) {
  const instrumentation = `
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    import cp from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    const originalSpawn = cp.spawn;
    cp.spawn = function(command, args, ...rest) {
      if (Array.isArray(args) && args.some(arg => String(arg).endsWith('signal-cli.jar'))) {
        appendFileSync(join(process.env.MURAGE_DATA_DIR, 'signal-spawn-count'), 'spawn\\n');
      }
      return originalSpawn.call(this, command, args, ...rest);
    };
    syncBuiltinESMExports();
    ${expected === 404 ? `registerHooks({ load(url, context, next) {
      const result = next(url, context);
      if (url.endsWith('/channels/signal/runtime-pin.json')) {
        const pin = JSON.parse(String(result.source)); pin.g0 = null;
        return { ...result, source: JSON.stringify(pin) };
      }
      return result;
    } });` : ""}
  `;
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import { launchVerificationServer, runControlMurage } from './scripts/control-murage.ts';
    import { readMcpAccessKey } from './server/mcp-access.ts';
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: ${JSON.stringify(instrumentation)} });
    try {
      const doctor = await runControlMurage(['doctor', '--url', fixture.info.url]);
      const response = await fetch(fixture.info.url + '/api/signal/status', {
        headers: { Authorization: 'Bearer ' + readMcpAccessKey(fixture.info.dataDir) }
      });
      // Readiness and request evidence contain no access key or account material.
      const signalSpawned = existsSync(fixture.info.dataDir + '/signal-spawn-count');
      const evidence = { fixture: fixture.info, doctor, status: response.status, signalSpawned };
      console.log(JSON.stringify(evidence));
      writeFileSync('evidence/signal-a5/isolated-status-${expected}.json', JSON.stringify(evidence, null, 2));
      writeFileSync('evidence/signal-a5/isolated-server-${expected}.log', readFileSync(fixture.info.logPath));
      if (response.status !== ${expected} || (${expected} === 404 && signalSpawned)) process.exitCode = 1;
    } finally { await fixture.close(); }
  `], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 180000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
it("T-B8-ACTIVATION: committed pin and G0 fixtures enable isolated desktop status 200", () => {
  if (process.env.RELEASE === "1") requireCommittedG0();
  isolatedSignalStatus(200);
}, 190000);
it("T-NO-SURFACE-UNVERIFIED: isolated desktop with g0:null returns 404 without a Signal child", () => {
  isolatedSignalStatus(404);
}, 190000);
it("T-NO-SURFACE-UNVERIFIED: committed unverified adapters expose no status or service", async () => {
  const f = wiringFixture(), route = routeFixture();
  route.context.enabled = f.signalEnabled();
  expect((await route.request("status", {}, "GET")).status).toBe(404);
  expect(route.service.status).not.toHaveBeenCalled(); expect(f.options()).toBeUndefined();
});

it.each(["g0-null", "tampered-byte", "manifest-version"])("T-NO-SURFACE-UNVERIFIED: %s keeps production routes closed without constructing a service", async cause => {
  // Synthetic manifest verifier input, confined to this temporary directory.
  const root = mkdtempSync(join(tmpdir(), "signal-source-derived-surface-"));
  try {
    // @ts-expect-error Synthetic ESM helper shared with staging tests.
    const { makeSyntheticEvidence } = await import('../scripts/fixtures/signal-test-evidence.mjs');
    const { pin, manifest, save } = makeSyntheticEvidence(root);
    expect(loadSignalAdapters(pin, root).verified).toBe(true);
    if (cause === "g0-null") pin.g0 = null;
    if (cause === "tampered-byte") writeFileSync(join(root, "own-note.json"), "tampered");
    if (cause === "manifest-version") { manifest.signalCliVersion = "mismatch"; save(); }
    const f = wiringFixture(root, pin), route = routeFixture(); route.context.enabled = f.signalEnabled();
    expect((await route.request("status", {}, "GET")).status).toBe(404);
    expect(f.options()).toBeUndefined(); expect(route.service.status).not.toHaveBeenCalled();
  } finally { removeTempDirSync(root); }
});
it('RED15 RED26 typed custody hold answers 200 and blocks all ordinary mutation entry points',async()=>{
 const {SignalKeptHoldService}=await import('./channels/signal/kept-hold.ts');
 const f=routeFixture(),prepare=vi.fn(async()=>({state:'not-linked' as const}));
 const held=new SignalKeptHoldService({state:'held',reason:'conflict',folder:'/fixture/data',dualCopy:false,canKeepBoth:true},prepare);
 f.context.service=held;
 expect((await f.request('status',{},'GET')).status).toBe(200);
 for(const action of ['link','connect-again','disconnect','finish-revocation','fix-permissions','retry-notes'])expect((await f.request(action)).status).toBe(409);
 expect(prepare).not.toHaveBeenCalled();
 expect((await f.request('keep-both-and-link',{extra:true})).status).toBe(400);
 expect((await f.request('keep-both-and-link')).status).toBe(200);expect(prepare).toHaveBeenCalledOnce();
 f.context.owner=false;expect((await f.request('keep-both-and-link')).status).toBe(404);
});

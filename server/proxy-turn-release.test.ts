import { afterEach, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
const hasIngress = existsSync(new URL("./consuming-turn-ingress.ts", import.meta.url));
// b18 has no final ingress module. Assert the missing release contract inside
// each case rather than failing ESM collection before any assertion runs.
const missingContract = <T extends object>(contract: string): T => new Proxy({} as T, {
  get: (_target, method) => () => {
    expect(hasIngress, `${contract}.${String(method)}: authenticated final acceptance must be implemented`).toBe(true);
    throw new Error("unreachable missing release contract");
  },
});
const ingressApi = hasIngress ? await import("./consuming-turn-ingress.ts") : missingContract<typeof import("./consuming-turn-ingress.ts")>("ingress");
const releaseApi = hasIngress ? await import("./proxy-turn-release.ts") : missingContract<typeof import("./proxy-turn-release.ts")>("release");
const responseApi = hasIngress ? await import("./consuming-turn-response.ts") : missingContract<typeof import("./consuming-turn-response.ts")>("response");
const fixtureApi = hasIngress ? await import("./testing/consuming-fixture.ts") : missingContract<typeof import("./testing/consuming-fixture.ts")>("bound fixture");
const ledgerApi = hasIngress ? await import("./ledger-refusal.ts") : missingContract<typeof import("./ledger-refusal.ts")>("exact-lease settlement");
const bridgeApi = hasIngress ? await import("./testing/bound-proxy-fixture.ts") : missingContract<typeof import("./testing/bound-proxy-fixture.ts")>("bound subprocess");
const { createConsumingIngress: rawIngress, decodeReleaseEnvelope, frameDigest, createProxyReleaseAuthority } = ingressApi;
const { createProxyTurnRelease, terminalProxyRefusal } = releaseApi;
const { registerConsumingDescriptor, bindConsumingTurn } = responseApi;
const { consumingFixture } = fixtureApi;
const { createLedgerRefusal } = ledgerApi;
const { runBoundBridge } = bridgeApi;
const LEDGER_REFUSAL_LINE = "I stopped this turn because some of its context is no longer available.";
const fixtures: ReturnType<typeof consumingFixture>[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.close()); vi.useRealTimers(); });
const fixture = () => { const f = consumingFixture(); fixtures.push(f); return f; };
const descriptor = hasIngress ? registerConsumingDescriptor("test:proxy", "body") : { id: "test:proxy", mode: "body" as const };
const createConsumingIngress = (...args: Parameters<typeof rawIngress>) => { const ingress = rawIngress(...args); ingress.request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }), () => {}); return ingress; };
const frame = { instanceId: "proxy", sequence: 1, frame: '{"jsonrpc":"2.0","id":1,"result":{}}', refs: [], descriptor };

// red-at-4df086541: a permit does not authorize delivery after a flip-only revoke.
it("T-PROXY-RELEASE rechecks at final ingress after permit issuance", () => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy"), write = vi.fn();
  const envelope = ingress.issue(frame); f.flip();
  expect(() => ingress.deliver(envelope, write)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});
// control: an accepted frame is delivered without its internal envelope.
it("delivers the exact frame once", () => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy"), write = vi.fn();
  ingress.deliver(ingress.issue(frame), write);
  expect(write).toHaveBeenCalledExactlyOnceWith(frame.frame);
});
// red-at-4df086541: stale, tampered, replayed and missing permits refuse.
it.each(["frame", "instance", "sequence", "permit", "replay", "replacement"])("refuses %s at the final sink", mutation => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy"), write = vi.fn();
  let envelope = ingress.issue(frame);
  if (mutation === "frame") envelope = { ...envelope, frame: "{}" };
  if (mutation === "instance") envelope = { ...envelope, instanceId: "other" };
  if (mutation === "sequence") envelope = { ...envelope, sequence: 2 };
  if (mutation === "permit") envelope = { ...envelope, permit: "" };
  if (mutation === "replay") ingress.deliver(envelope, write);
  if (mutation === "replacement") f.replace();
  write.mockClear();
  expect(() => ingress.deliver(envelope, write)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});
// red-at-4df086541: local fallback is forbidden after control-channel failure.
it("seals before supervisor terminal control and suppresses queued replies", async () => {
  const order: string[] = [], terminal = vi.fn(), envelope = vi.fn();
  const release = createProxyTurnRelease("proxy", {
    verdict: async () => { throw new Error("transport failed"); }, envelope,
    seal: () => order.push("seal"), terminal: value => { order.push("terminal"); terminal(value); }, close: () => order.push("close"),
  });
  await expect(release.release(1, frame)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  await expect(release.release(2, frame)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(order).toEqual(["seal", "terminal", "close"]);
  expect(terminal).toHaveBeenCalledExactlyOnceWith(terminalProxyRefusal(1)); expect(envelope).not.toHaveBeenCalled();
});
// red-at-4df086541: a missing ingress acknowledgement is terminal too.
it.each(["verdict", "acknowledgement"])("seals on the five-second %s deadline", async stage => {
  vi.useFakeTimers();
  const seal = vi.fn(), terminal = vi.fn(), close = vi.fn();
  const never = () => new Promise<never>(() => {});
  const release = createProxyTurnRelease("proxy", {
    verdict: stage === "verdict" ? never : async request => ({ instanceId: "proxy", sequence: request.sequence, frame: request.frame, permit: "a".repeat(43) }),
    envelope: stage === "acknowledgement" ? never : async () => {}, seal, terminal, close,
  });
  const result = expect(release.release(1, frame)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  await vi.advanceTimersByTimeAsync(5000); await result;
  expect(seal).toHaveBeenCalledTimes(1); expect(terminal).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
});

import { EventEmitter } from "node:events";
import { InternalCapabilities, requiredInternalKind } from "./internal-capabilities.ts";
import { readFileSync } from "node:fs";
import { SPAWNED_PROXY_FILES } from "../shared/spawned-proxies.mjs";
const proxyRoles = ["memory", "agents", "browser", "phone", "dweb", "hostComputer", "unifiedBrowser", "headlessBrowser", "phoneJobs", "remoteMcp", "connectors", "computer", "permission", "containerMcp", "vpsContainerMcp", "vpsRelayMcp"] as const;
const responses = ["initialize", "ping", "tools/list", "validation", "unknown-method", "local-help", "asynchronous", "notification", "server-request"] as const;
// red-at-4df086541: every response class used raw stdout, including nominally static replies.
it.each(proxyRoles.flatMap(role => responses.map(response => ({ role, response }))))("T-PROXY-RELEASE $role $response flip-only at final delivery", ({ role, response }) => {
  const f = fixture(), ingress = rawIngress(f.binding, role), writes: string[] = [];
  const descriptor = registerConsumingDescriptor(`proxy:${role}:frame`, "body");
  const payload = response === "notification" ? { jsonrpc: "2.0", method: "notifications/tools/list_changed" }
    : response === "server-request" ? { jsonrpc: "2.0", id: "upstream-1", method: "elicitation/create", params: {} }
    : { jsonrpc: "2.0", id: 1, ...(response === "validation" || response === "unknown-method" ? { error: { code: -32602, message: "invalid" } } : { result: { text: "live" } }) };
  if (!("method" in payload)) ingress.request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: response }), () => {});
  const first = ingress.issue({ instanceId: role, sequence: 1, frame: JSON.stringify(payload), refs: [], descriptor });
  ingress.deliver(first, value => writes.push(value));
  expect(writes).toEqual([JSON.stringify(payload)]); // non-vacuous live precondition
  if (!("method" in payload)) ingress.request(JSON.stringify({ jsonrpc: "2.0", id: 1, method: response }), () => {});
  const nextPayload = response === "server-request" ? { ...payload, id: "upstream-2" } : payload;
  const second = ingress.issue({ instanceId: role, sequence: 2, frame: JSON.stringify(nextPayload), refs: [], descriptor });
  f.flip(); writes.length = 0;
  expect(() => ingress.deliver(second, value => writes.push(value))).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(writes).toEqual([]); expect(f.refusals).toBe(1); expect(ingress.sealed).toBe(true);
});
// red-at-4df086541: a queue/drain wait used an earlier authorization.
it("T-FINAL-INGRESS-DRAIN-RACE checks after capacity resolves", async () => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy"), write = vi.fn();
  let drain!: () => void;
  const waiting = ingress.accept(ingress.issue(frame), { capacity: () => new Promise<void>(resolve => { drain = resolve; }), write });
  f.flip(); drain();
  await expect(waiting).rejects.toThrow("MEMORY_CONTEXT_REVOKED"); expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});
// red-at-4df086541: revocation after issuing a permit was invisible at stdout.
it("T-FINAL-INGRESS-REVOKE-RACE rejects a ledger revision change", () => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy"), write = vi.fn();
  const envelope = ingress.issue(frame);
  addTurnParents(f.turn, [{ kind: "line", threadId: "T", messageId: "Y" }]);
  expect(() => ingress.deliver(envelope, write)).toThrow("MEMORY_CONTEXT_REVOKED"); expect(write).not.toHaveBeenCalled();
});
import { addTurnParents } from "./memory/lineage-write.ts";
// red-at-4df086541: duplicated permits and duplicate response ids could be reused.
it("T-PERMIT-REPLAY consumes before a reentrant destination", () => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy");
  const envelope = ingress.issue(frame), nested = vi.fn();
  expect(() => ingress.deliver(envelope, () => ingress.deliver(envelope, nested))).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(nested).not.toHaveBeenCalled(); expect(ingress.sealed).toBe(true);
});
// red-at-4df086541: EOF/exit/error were local errors, not synchronous bound stops.
it.each(["end", "exit", "close", "disconnect", "error"])("T-PROXY-SUPERVISOR-LOSS %s seals before continuation", event => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy"), source = new EventEmitter(), write = vi.fn();
  const permit = ingress.issue(frame); ingress.supervise(source);
  source.emit(event); expect(ingress.sealed).toBe(true); expect(f.refusals).toBe(0);
  expect(() => ingress.deliver(permit, write)).toThrow("MEMORY_CONTEXT_REVOKED"); expect(write).not.toHaveBeenCalled();
});
// red-at-4df086541: no parent-owned deadline existed when the child vanished silently.
it("T-PROXY-SUPERVISOR-LOSS missing acknowledgement seals server permit", async () => {
  vi.useFakeTimers(); const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy");
  ingress.issue(frame); await vi.advanceTimersByTimeAsync(5000);
  expect(ingress.sealed).toBe(true); expect(f.refusals).toBe(1);
});
// red-at-4df086541: unvalidated JSON, unknown ids and duplicate ids passed through.
it.each(["{}", "[]", '{"jsonrpc":"2.0","id":2,"result":{}}', '{"jsonrpc":"2.0","id":null,"result":{}}', '{"jsonrpc":"2.0","id":1,"result":{},"error":{}}', '{"jsonrpc":"2.0","id":1.1,"result":{}}', '{"jsonrpc":"2.0","method":"x","result":{}}'])("T-PROXY-RELEASE invalid frame %#", invalid => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy");
  expect(() => ingress.issue({ ...frame, frame: invalid })).toThrow("MEMORY_CONTEXT_REVOKED"); expect(f.refusals).toBe(1);
});
// red-at-4df086541: envelope metadata must be decoded as a bounded internal protocol.
it("T-PERMIT-REPLAY envelope decoding rejects extra fields and wrong digest", () => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy"), envelope = ingress.issue(frame);
  expect(decodeReleaseEnvelope(JSON.stringify(envelope))).toEqual(envelope);
  expect(() => decodeReleaseEnvelope(JSON.stringify({ ...envelope, binding: {} }))).toThrow();
  expect(() => ingress.deliver({ ...envelope, frame: frame.frame.replace('{}', '{"x":1}') }, vi.fn())).toThrow("MEMORY_CONTEXT_REVOKED");
});
// red-at-4df086541: verdict authority did not exist; ordinary tool tokens must not work.
it("T-PROXY-RELEASE authenticated control binds the original instance and exact frame", () => {
  const f = fixture(), caps = new InternalCapabilities();
  caps.begin("B", "T", f.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(caps), instance = authority.register(f.binding, descriptor, () => []);
  instance.ingress.request('{"jsonrpc":"2.0","id":1,"method":"ping"}', () => {});
  const claim = caps.resolve(`Bearer ${instance.token}`)!;
  expect(requiredInternalKind("/api/internal/turn-release/v1/verdict")).toBe("turn-release");
  const body = { instanceId: instance.instanceId, sequence: 1, frame: frame.frame, bytes: Buffer.byteLength(frame.frame), digest: frameDigest(frame.frame), descriptor: descriptor.id, requestId: 1 };
  const envelope = authority.verdict(claim, body);
  const write = vi.fn(); instance.ingress.deliver(envelope, write); expect(write).toHaveBeenCalledOnce();
  const ordinary = caps.mint({ botId: "B", threadId: "T", generation: f.binding.identity.dispatchGeneration, kind: "memory", depth: 0, skillAuthoring: false });
  expect(() => authority.verdict(caps.resolve(`Bearer ${ordinary}`)!, body)).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(() => authority.verdict(claim, { ...body, sequence: 2, digest: "wrong" })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.refusals).toBe(1);
});
// red-at-4df086541: importing a gate while retaining stdout still leaves a bypass.
it.each(proxyRoles)("T-PROXY-RELEASE %s owns no direct stdout writer", role => {
  const source = finalProxySource(role, readFileSync(new URL(`../server/${SPAWNED_PROXY_FILES[role]}.ts`, import.meta.url), "utf8"));
  expect(/process\.stdout\.write\s*\(/.test(source), `${role} bypasses final release`).toBe(false);
  expect(/sendProxyFrame|writeMcpLine|releaseProxyFrame|runMcpBridge|createMcpCatalogWriter/.test(source), `${role} uses a registered final writer`).toBe(true);
});
it("catalog writer routes final bytes through the registered release", () => {
  const source = readFileSync(new URL("./mcp-listed.ts", import.meta.url), "utf8");
  expect(source).toContain('if (releaseRole)');
  expect(source).toContain('releaseProxyFrame(releaseRole, line.replace');
});
// red-at-4df086541: packaged proxies and external Pi lacked release/ingress entries.
it("T-RELEASE-PACKAGED-ENTRY ships ingress, client and external Pi dependency", () => {
  const bundle = readFileSync(new URL("../scripts/bundle-server.mjs", import.meta.url), "utf8");
  expect(SPAWNED_PROXY_FILES.consumingIngress).toBe("consuming-turn-ingress");
  for (const entry of ["consuming-turn-ingress.ts", "proxy-turn-release.ts", "ledger-refusal.ts"])
    expect(bundle.includes(JSON.stringify(entry)), `${entry} must ship`).toBe(true);
});

import ts from "typescript";
// The relay's pipe child feeds the outer bridge, not the engine. Classify
// only that exact branch; every outer/top-level write remains a final sink.
function finalProxySource(role: string, source: string): string {
  if (role !== "vpsRelayMcp") return source;
  const root = ts.createSourceFile("relay.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const branches = root.statements.filter(ts.isIfStatement).filter(node => node.expression.getText() === 'process.argv[2] !== "pipe"');
  expect(branches).toHaveLength(1);
  const branch = branches[0]!;
  expect(branch.thenStatement.getText()).toContain('releaseRole: "vpsRelayMcp"');
  expect(branch.thenStatement.getText()).toContain('args: [...process.execArgv, fileURLToPath(import.meta.url), "pipe"]');
  expect(rawProxyWrites(branch.thenStatement.getText())).toBe(0);
  expect(branch.elseStatement).toBeDefined();
  expect(rawProxyWrites(branch.elseStatement!.getText())).toBe(1);
  return source.slice(0, branch.elseStatement!.getStart()) + '{}' + source.slice(branch.elseStatement!.end);
}
function rawProxyWrites(text: string): number {
  const root = ts.createSourceFile("fixture.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Set<string>(); let violations = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (node.initializer.getText().startsWith("process.stdout") || aliases.has(node.initializer.getText()))) aliases.add(node.name.text);
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      if (/^process\.stdout\.(write|end)$/.test(callee) || [...aliases].some(alias => callee === alias || callee === `${alias}.write` || callee === `${alias}.end`)) violations++;
      if (/(?:^|\.)writeSync$/.test(callee) && node.arguments[0]?.getText() === "1") violations++;
      if (callee === "writeMcpLine" && node.arguments[0]?.getText() === "process.stdout" && node.arguments.length < 3) violations++;
    }
    ts.forEachChild(node, visit);
  };
  visit(root); return violations;
}
// control: the inventory scanner detects writer aliases and fd 1 despite a nearby release import.
it.each([
  'process.stdout.write("payload")', 'const output = process.stdout; output.write("payload")',
  'const send = process.stdout.write; send("payload")', 'writeSync(1, "payload")',
  'writeMcpLine(process.stdout, "payload")',
])("T-PROXY-RELEASE inventory rejects a hidden local writer %#", mutation => {
  expect(rawProxyWrites('import {sendProxyFrame} from "./proxy-turn-release.ts";\n' + mutation)).toBeGreaterThan(0);
});
// control: the child-facing path has no authority to send an engine response.
it("T-PROXY-RELEASE inventory distinguishes child requests from bound releases", () => {
  expect(rawProxyWrites('writeMcpLine(child.stdin, line); writeMcpLine(process.stdout, line, "containerMcp");')).toBe(0);
});
// red-at-4df086541: the actual proxy manifest must have no independent local writer.
it.each(proxyRoles)("T-PROXY-RELEASE %s sink-flow scan", role => {
  expect(rawProxyWrites(finalProxySource(role, readFileSync(new URL(`../server/${SPAWNED_PROXY_FILES[role]}.ts`, import.meta.url), "utf8")))).toBe(0);
});
it("relay inventory still detects an added outer stdout bypass", () => {
  const source = readFileSync(new URL("./cloud-home/vps-relay-mcp.ts", import.meta.url), "utf8");
  expect(rawProxyWrites(finalProxySource("vpsRelayMcp", source + '\nprocess.stdout.write("bypass");'))).toBe(1);
});
// red-at-4df086541: client completion failures could produce recoverable content.
it.each(proxyRoles)("T-PROXY-RELEASE %s upstream failure is terminal even with a live ledger", async role => {
  const f = fixture(), ingress = rawIngress(f.binding, role), terminal = vi.fn(), write = vi.fn();
  const release = createProxyTurnRelease(role, { verdict: async () => { throw new Error("upstream"); }, envelope: async value => ingress.deliver(value, write),
    seal: ingress.seal, terminal, close: vi.fn() });
  await expect(release.release(1, frame)).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(f.refusals).toBe(1); expect(write).not.toHaveBeenCalled(); expect(terminal).toHaveBeenCalledExactlyOnceWith(terminalProxyRefusal(1));
});
// red-at-4df086541: cancellation previously carried text and preceded sealing.
it("T-PROXY-SUPERVISOR-LOSS cancellation seals first and contains only a bound id", () => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy");
  const sent: unknown[] = [];
  ingress.cancel(1, value => { expect(f.refusals).toBe(1); sent.push(JSON.parse(value)); });
  expect(sent).toEqual([{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }]);
  expect(() => ingress.issue(frame)).toThrow("MEMORY_CONTEXT_REVOKED");
});

// red-at-4df086541: supervisor errors were not connected to an immutable lease's
// seal/interrupt/once-only settlement; a replacement must remain untouched.
it.each(proxyRoles)("T-PROXY-SUPERVISOR-LOSS %s interrupts only its admitted lease once", async role => {
  const old = fixture(), next = fixture(), order: string[] = [], interrupted: string[] = [];
  const settle = vi.fn(), present = vi.fn();
  const stop = createLedgerRefusal(old.binding.identity, {
    seal: () => order.push("seal"),
    interrupt: async () => { order.push("interrupt"); interrupted.push(old.binding.identity.adapterLeaseId); return true; },
    settle, present, quarantine: vi.fn(),
  });
  const binding = bindConsumingTurn({ ...old.binding, onLedgerRefused: verdict => { stop.onLedgerRefused(verdict); old.binding.onLedgerRefused(verdict); } });
  const ingress = rawIngress(binding, role), source = new EventEmitter(); ingress.supervise(source);
  old.replace(); source.emit("disconnect"); source.emit("exit");
  expect(order).toEqual(["seal", "interrupt"]); expect(interrupted).toEqual([old.binding.identity.adapterLeaseId]);
  expect(settle).toHaveBeenCalledOnce(); expect(present).toHaveBeenCalledExactlyOnceWith(LEDGER_REFUSAL_LINE);
  const nextIngress = rawIngress(next.binding, "replacement"), write = vi.fn();
  nextIngress.request('{"jsonrpc":"2.0","id":1,"method":"ping"}', () => {});
  nextIngress.deliver(nextIngress.issue({ ...frame, instanceId: "replacement" }), write);
  expect(write).toHaveBeenCalledOnce(); expect(next.refusals).toBe(0);
  await Promise.resolve(); expect(settle).toHaveBeenCalledOnce();
});
// red-at-4df086541: a delayed completion must not inherit a replacement's identity.
it("T-PROXY-RELEASE stale asynchronous verdict suppresses a queued envelope", async () => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy"), write = vi.fn();
  let resume!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const release = createProxyTurnRelease("proxy", { verdict: async request => { await blocked; return ingress.issue(request); },
    envelope: async envelope => ingress.deliver(envelope, write), seal: ingress.seal, terminal: vi.fn(), close: vi.fn() });
  const pending = release.release(1, frame); f.replace(); resume();
  await expect(pending).rejects.toThrow("MEMORY_CONTEXT_REVOKED"); expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(1);
});
// red-at-4df086541: staging could grow without bound before requesting any verdict.
it("T-PROXY-RELEASE bounded pending queue seals synchronously", async () => {
  const seal = vi.fn(), release = createProxyTurnRelease("proxy", { verdict: () => new Promise(() => {}), envelope: async () => {}, seal, terminal: vi.fn(), close: vi.fn() });
  const requests = Array.from({ length: 65 }, () => release.release(1, frame).catch(() => {}));
  expect(seal).toHaveBeenCalledOnce(); expect(release.sealed).toBe(true);
  await Promise.all(requests);
});

import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
it("real relay pipe reaches the outer consuming writer and revocation suppresses final delivery", async () => {
  const ws = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => ws.once("listening", resolve));
  let forwarded = 0;
  ws.on("connection", socket => socket.on("message", raw => {
    const request = JSON.parse(String(raw)); forwarded++;
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }));
  }));
  const path = fileURLToPath(new URL("./cloud-home/vps-relay-mcp.ts", import.meta.url));
  const script = `process.execArgv.splice(0, process.execArgv.length, "--experimental-strip-types"); process.argv[1] = ${JSON.stringify(path)}; await import(${JSON.stringify(new URL("./cloud-home/vps-relay-mcp.ts", import.meta.url).href)});`;
  const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const env = { MURAGE_CONTROL_URL: `http://127.0.0.1:${(ws.address() as import("node:net").AddressInfo).port}`, MURAGE_CONTROL_TOKEN: "fixture" };
  try {
    expect(await runBoundBridge(script, [request], 1, false, { role: "vpsRelayMcp", env })).toHaveLength(1);
    expect(await runBoundBridge(script, [request], 0, false, { role: "vpsRelayMcp", env, flipBeforeDelivery: true })).toEqual([]);
    expect(forwarded).toBe(2);
  } finally {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
  }
});
// red-at-4df086541: actual spawned entries previously wrote ordinary stdout;
// each case first delivers through authenticated issuance, then flips only after
// the real proxy has received a permit and serialized its envelope.
it.each(["memory", "agents", "browser", "phone", "dweb", "computer"] as const)("T-PROXY-RELEASE real %s local response classes", async role => {
  const path = fileURLToPath(new URL(`./${SPAWNED_PROXY_FILES[role]}.ts`, import.meta.url));
  const script = `process.argv[1] = ${JSON.stringify(path)}; await import(${JSON.stringify(new URL(`./${SPAWNED_PROXY_FILES[role]}.ts`, import.meta.url).href)});`;
  for (const method of ["initialize", "ping", "tools/list", "unknown-method"]) {
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} });
    const live = await runBoundBridge(script, [request], 1, false, { role });
    expect(live).toHaveLength(1); expect(JSON.parse(live[0]!).id).toBe(1);
    expect(await runBoundBridge(script, [request], 0, false, { role, flipBeforeDelivery: true })).toEqual([]);
  }
}, 90_000);
// red-at-4df086541: the dedicated authority seals even before a verdict can be issued.
it("T-PROXY-SUPERVISOR-LOSS request-body transport failure seals its instance", () => {
  const f = fixture(), caps = new InternalCapabilities(); caps.begin("B", "T", f.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(caps), instance = authority.register(f.binding, descriptor, () => []);
  const claim = caps.resolve(`Bearer ${instance.token}`)!;
  authority.seal(claim); authority.seal(claim);
  expect(instance.ingress.sealed).toBe(true); expect(f.refusals).toBe(1);
});

// red-at-4df086541: repeated transport loss and backpressure wakeups cannot
// resurrect an already-issued permit or settle the same binding twice.
it("T-PROXY-RELEASE EOF during drain suppresses the queued engine frame", async () => {
  const f = fixture(), ingress = createConsumingIngress(f.binding, "proxy"), write = vi.fn(), source = new EventEmitter();
  ingress.supervise(source);
  let drain!: () => void;
  const pending = ingress.accept(ingress.issue(frame), { capacity: () => new Promise<void>(resolve => { drain = resolve; }), write });
  source.emit("end"); source.emit("close"); drain();
  await expect(pending).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
  expect(write).not.toHaveBeenCalled(); expect(f.refusals).toBe(0); expect(ingress.sealed).toBe(true);
});

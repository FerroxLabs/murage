// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.22 userbug-sealed (owner report, Windows, 1.0.21, Claude engine): almost every turn ended on one of two cards,
// "Murage closed this bot's tool connection before your message went out" (cause code mount-relay-sealed) or "this conversation's memory was
// not ready yet, so Murage held your message back" (cause code memory-fence).
// Owners: userbug-sealed builder owns the owner rule for a proposal refused only on held context still checking:pending
// (memory/send-fence.ts ownerHeldPendingProposal); the retained ledger, the deny reader, the ingress, the release door and the relay are
// unchanged. The recall side of a check that never settles (the session kept on checking:pending) belongs to lane fix1022-recall-checking.
//
// Cause: a mount's reply is a PROPOSAL (what the turn holds plus the reply's refs: ingress.issue -> proposeTurnParents). When the context the
// owner's turn already holds was still checking:pending (a revoke walk that has not finished, here one that never does), the proposal
// refused the whole turn at the release door (the door has no deferral: ledger refusal -> the proxy's terminal -> relay sealed -> card), and
// on the relay's own acceptance it held the reply for the full pending wait and then dropped it. The A-5 owner rule only covered a release
// that re-checks held context alone, never a proposal.
// Real fence, real deny reader, real ledger, real ingress, real release authority (the door's handler) and a real relay on its real
// listener (a named pipe on Windows, a socket elsewhere); only the mount child and the CLI process are stand-ins.
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { connect } from "node:net";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createConsumingIngress, createProxyReleaseAuthority, frameDigest } from "../consuming-turn-ingress.ts";
import { emitConsumingTurnResponse, registerConsumingDescriptor } from "../consuming-turn-response.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { createTurnCredentialStore } from "./turn-credentials.ts";
import { mountStopCause } from "./stop-copy.ts";
import { refsLookup } from "../memory/deny-read.ts";
import { addTurnParents } from "../memory/lineage-write.ts";
import { MEMBER } from "../memory/testing/writetime-fixture.ts";
import type { LineageVerdict } from "../memory/lineage-types.ts";
import type { SendTurnInput } from "../contracts.ts";

vi.mock("../procs.ts", async original => ({
  ...await original<typeof import("../procs.ts")>(),
  killCliTree: vi.fn(), awaitCliTreeStopped: async () => true,
  cliTreeStoppedSignal: () => new Promise<true>(() => {}),
}));
// The revoke runner never runs here: the check never settles, as on the owner's machine.
vi.mock("../memory/memory-revocation.ts", async original => ({
  ...await original<typeof import("../memory/memory-revocation.ts")>(),
  wakeMemoryRevocation: () => {},
}));
const { CliMountRelay, RelayedMount } = await import("./cli-mount-relay.ts");

const cleanups: Array<() => void | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const held = { kind: "line", threadId: "T", messageId: "X" } as const;
const fresh = { kind: "line", threadId: "T", messageId: "Y" } as const;
const descriptor = registerConsumingDescriptor("test:proxy", "body");
const call = (id: number, method: string) => JSON.stringify({ jsonrpc: "2.0", id, method, params: {} });
const answer = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "fixture tool words" }] } });

/** An owner turn as index.ts binds it (the A-5 keep hook), holding line X. `written`: what the hook answers, as in production: no while
 * the prompt is unwritten (that turn is rebuilt), yes once it was released or the session was kept on checking:pending. */
function ownerTurn(written: boolean, owner = true) {
  const told: Array<LineageVerdict | undefined> = [];
  const f = consumingFixture(undefined, { botId: randomUUID(), ...(owner ? { continuePending: (verdict?: LineageVerdict) => { if (written) told.push(verdict); return written; } } : {}) });
  cleanups.push(() => f.close());
  /** A revoke window that never settles: an active job whose walk is never run, pending over the whole thread. */
  const neverSettles = () => {
    f.f.job(1, 50).pending("T", 1);
    expect(refsLookup(f.f.db, [held], MEMBER)).toMatchObject({ state: "checking", reason: "pending" });
    expect(refsLookup(f.f.db, [fresh], MEMBER)).toMatchObject({ state: "checking", reason: "pending" });
  };
  return { f, told, neverSettles };
}

/** The release door's handler for one bundled proxy of that turn (server/index.ts POST /api/internal/turn-release/v1/verdict calls
 * authority.verdict with the resolved claim and the body, nothing else). */
function door(t: ReturnType<typeof ownerTurn>) {
  const caps = new InternalCapabilities();
  caps.begin(t.f.binding.identity.botId, t.f.turn.threadId, t.f.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(caps);
  const instance = authority.register(t.f.binding, descriptor, () => []);
  const claim = caps.resolve(`Bearer ${instance.token}`)!;
  const body = (sequence: number, frame: string) => ({ instanceId: instance.instanceId, sequence, frame, bytes: Buffer.byteLength(frame),
    digest: frameDigest(frame), descriptor: descriptor.id, requestId: JSON.parse(frame).id });
  return { authority, instance, claim, body };
}

it("USERBUG-SEALED-W1c door handler (component; the booted-server W1 is in fence-pending-turn-api.test.ts): an owner's turn whose held context is checking:pending forever is not refused by a proxy's reply; the reply is released", () => {
  const t = ownerTurn(true), d = door(t);
  // the engine's handshake and one call reach the proxy before the window opens
  d.instance.ingress.request(call(1, "initialize"), () => {});
  d.instance.ingress.request(call(2, "tools/call"), () => {});
  t.neverSettles();
  let envelope: ReturnType<typeof d.authority.verdict> | undefined, thrown: unknown;
  try { envelope = d.authority.verdict(d.claim, d.body(1, answer(1))); } catch (error) { thrown = error; }
  expect(t.f.refusals, "memory readiness never refuses the owner's turn").toBe(0);
  expect(thrown, "the door answers the proxy with its permit, not a refusal").toBeUndefined();
  expect(d.instance.ingress.sealed, "the proxy's instance stays open: its relay is not sealed").toBe(false);
  const written: string[] = [];
  d.instance.ingress.deliver(envelope!, frame => { written.push(frame); });
  expect(written, "the reply itself reaches the engine").toEqual([answer(1)]);
  // and the next reply of the same turn, the tool's own
  const next = d.authority.verdict(d.claim, d.body(2, answer(2)));
  d.instance.ingress.deliver(next, frame => { written.push(frame); });
  expect(written).toEqual([answer(1), answer(2)]);
  expect(t.f.refusals).toBe(0);
  expect(t.told.length, "the owner's hook was asked (it tells the left-out note once)").toBeGreaterThan(0);
  expect(t.told.every(verdict => verdict?.state === "checking" && verdict.reason === "pending")).toBe(true);
});

it("USERBUG-SEALED-G1 door guard: a NEW ref that is still checking:pending is never released on the owner rule; the turn refuses as before", () => {
  const t = ownerTurn(true);
  const ingress = door(t).instance.ingress;
  ingress.request(call(1, "tools/call"), () => {});
  t.neverSettles();
  // the reply would add line Y, which the turn does not hold and whose check has not settled
  // the tool-exchange ingress the door and the relay use (registered by the release authority: ownerToolExchange)
  expect(() => ingress.issue({ instanceId: ingress.identity.proxyInstanceId, sequence: 1, frame: answer(1), descriptor, refs: [fresh] })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(t.f.refusals).toBe(1);
  expect(t.told, "nothing is told for a proposal that refuses").toEqual([]);
});

it("USERBUG-SEALED-G2 door guard: while the owner's prompt is unwritten (the hook says no) the pending proposal still refuses: that turn is rebuilt, never continued", () => {
  const t = ownerTurn(false), d = door(t);
  d.instance.ingress.request(call(1, "initialize"), () => {});
  t.neverSettles();
  expect(() => d.authority.verdict(d.claim, d.body(1, answer(1)))).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(t.f.refusals).toBe(1);
  expect(d.instance.ingress.sealed).toBe(true);
});

it("USERBUG-SEALED-G3 door guard: a turn that is not the owner's (no keep hook) still refuses on the same pending check", () => {
  const t = ownerTurn(true, false), d = door(t);
  d.instance.ingress.request(call(1, "tools/call"), () => {});
  t.neverSettles();
  expect(() => d.authority.verdict(d.claim, d.body(1, answer(1)))).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(t.f.refusals).toBe(1);
});

it("USERBUG-SEALED-G4 regression guard (green on base, not the fix's witness): a proven revoke of what the owner's turn holds keeps its own rule under the same window", () => {
  const t = ownerTurn(true), d = door(t);
  d.instance.ingress.request(call(1, "tools/call"), () => {});
  t.neverSettles();
  // line X is now revoked for real: the pending rule must not cover it (the keep rule drops it and the proposal is validated again)
  t.f.f.db.prepare("INSERT INTO memory_revoke_audience(revoke_id) VALUES(7)").run(); t.f.f.denyLine("T", 1, 7);
  expect(refsLookup(t.f.f.db, [held], MEMBER).state).toBe("withheld");
  const envelope = d.authority.verdict(d.claim, d.body(1, answer(1)));
  d.instance.ingress.deliver(envelope, () => {});
  expect(t.f.refusals).toBe(0);
  expect(t.told.some(verdict => verdict?.state === "withheld"), "the revoke took the keep rule, not the pending rule").toBe(true);
});

it("USERBUG-SEALED-G5 scope guard: a proposal that is not a tool's reply (a steer's quote, a bring-in, a prompt's or a receipt's parents) keeps the refusal on the same owner turn", () => {
  const t = ownerTurn(true);
  door(t).instance.ingress.request(call(1, "tools/call"), () => {});
  t.neverSettles();
  // the same owner turn, hook yes, held context exactly pending, nothing new: only the caller differs (no ownerProposal)
  expect(() => addTurnParents(t.f.binding.turn, [])).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(t.f.refusals).toBe(1);
  expect(t.told, "the owner rule was not asked").toEqual([]);
});

it("USERBUG-SEALED-G6 scope guard: a consuming emission that is not the tool exchange (engine input, model gateway, an internal HTTP reply) keeps the refusal on the same owner turn", () => {
  const t = ownerTurn(true);
  door(t).instance.ingress.request(call(1, "tools/call"), () => {});
  t.neverSettles();
  const written: string[] = [];
  // the shared final gate, as engine-input.ts / model-gateway.ts / the internal HTTP writer call it: no ownerProposal
  expect(() => emitConsumingTurnResponse(t.f.binding, descriptor, { bytes: 4, refs: [], write: () => { written.push("out"); } })).toThrow("MEMORY_CONTEXT_REVOKED");
  expect(written).toEqual([]);
  expect(t.f.refusals).toBe(1);
  expect(t.told, "the owner rule was not asked").toEqual([]);
});

it("USERBUG-SEALED-G7 scope guard: an ingress that is not the turn's tool exchange (the own-server VPS relay creates its own) does not forward a call on the owner rule", () => {
  const t = ownerTurn(true);
  const vps = createConsumingIngress(t.f.binding, "fixture-vps-instance");
  t.neverSettles();
  const forwarded: string[] = [];
  try { vps.request(call(1, "tools/call"), () => { forwarded.push("call"); }); } catch { /* deferred or refused: either way not forwarded */ }
  expect(forwarded, "the call is not forwarded while held context is still checking:pending").toEqual([]);
  expect(t.told, "the owner rule was not asked").toEqual([]);
});

/** The relay's own listener: process.platform decides its address (procs.ts brokerSocketPath: \\.\pipe\murage-perm-... on win32, a socket
 * file elsewhere), so this case is the win32 pipe path when the file runs on Windows. */
it("USERBUG-SEALED-W2 relay (named pipe on Windows, socket elsewhere): a tool reply on the owner's turn is delivered at once under a check that never settles; the relay is never sealed", async () => {
  const t = ownerTurn(true);
  const caps = new InternalCapabilities(); caps.begin(t.f.binding.identity.botId, t.f.turn.threadId, t.f.binding.identity.dispatchGeneration);
  const admission = createMcpMountAdmission(t.f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1");
  const cred = createTurnCredentialStore(); cleanups.push(() => cred.dispose());
  const turn: SendTurnInput = { threadId: t.f.turn.threadId, text: "Reply with READY", warmIdentity: { botId: t.f.binding.identity.botId, audience: "owner" },
    releaseBinding: t.f.binding, mountAdmission: admission };
  const children: ChildProcess[] = [];
  const spawn = vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: undefined, exitCode: null, signalCode: null, connected: false, send: vi.fn() }) as unknown as ChildProcess;
    children.push(child); return child;
  });
  const relay = await CliMountRelay.create(turn, { muragebox: { command: "fixture-mcp", args: [], env: {} } }, {}, cred, spawn);
  cleanups.push(() => relay.finish());
  if (process.platform === "win32") expect(relay.socketPath.startsWith("\\\\.\\pipe\\")).toBe(true);
  const cli = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, pid: undefined }) as unknown as ChildProcess;
  const causes: string[] = [];
  relay.attach(cli, (nativeError, refusal) => { causes.push(mountStopCause(nativeError, refusal, undefined).code); });
  const socket = connect(relay.socketPath); cleanups.push(() => { socket.destroy(); });
  socket.on("error", () => {}); await once(socket, "connect");
  socket.write(JSON.stringify({ ticket: relay.ticket, server: "muragebox" }) + "\n");
  const engine: string[] = []; socket.on("data", chunk => engine.push(...String(chunk).split("\n").filter(Boolean)));
  const forwarded: string[] = []; children[0]!.stdin!.on("data", chunk => forwarded.push(...String(chunk).split("\n").filter(Boolean)));
  socket.write(call(1, "initialize") + "\n");
  await vi.waitFor(() => expect(forwarded).toHaveLength(1));
  t.neverSettles();
  // the shipped bound is untouched (65 s): the reply must not wait for it
  expect(RelayedMount.pendingWaitMs).toBeGreaterThanOrEqual(60_000);
  children[0]!.stdout!.emit("data", Buffer.from(answer(1) + "\n"));
  await vi.waitFor(() => expect(engine.map(line => JSON.parse(line).id), "the reply reaches the engine without waiting for the check").toEqual([1]), { timeout: 5000 });
  expect(JSON.parse(engine[0]!).result, "the reply itself, not the still-checking error").toEqual(JSON.parse(answer(1)).result);
  // the next call and its reply run too
  socket.write(call(2, "tools/call") + "\n");
  await vi.waitFor(() => expect(forwarded.map(line => JSON.parse(line).id)).toEqual([1, 2]), { timeout: 5000 });
  children[0]!.stdout!.emit("data", Buffer.from(answer(2) + "\n"));
  await vi.waitFor(() => expect(engine.map(line => JSON.parse(line).id)).toEqual([1, 2]), { timeout: 5000 });
  expect(causes, "no seal, so no card (mount-relay-sealed / memory-fence)").toEqual([]);
  expect(t.f.refusals).toBe(0);
  expect(relay.mounts.get("muragebox")!.mount.ingress.sealed).toBe(false);
  await expect(relay.finish()).resolves.toBe(true);
});

/** ASTRA n4:5920 + ASTRA pre-check r3 (userbug-sealed-fable-r4 SITES.md R1-R19): index.ts opts an internal route's answer in only when the
 * ALLOWLIST ownerToolExchangeRoute(method, path) names it. Table-driven over the whole route inventory (consuming-sink-inventory.ts: every
 * static route and each dynamic route grammar), so a route added to the inventory fails here until it is classified. Predicate guard; the
 * booted W1 drives an opted-in route and the booted W3 (fence-pending-turn-api.test.ts) the heartbeat through index.ts. */
it("USERBUG-SEALED-G8 scope guard: only a route that answers a bundled tool takes the owner rule; proxy control and publication traffic, and any route not named, do not", async () => {
  const { INTERNAL_HTTP_ROUTES, PROJECT_ROUTE_NAMES, EMAIL_ROUTE_NAMES, registeredInternalRoute } = await import("../consuming-sink-inventory.ts");
  // 435d038d9c has no opt-in at all (consumingHttpWriter takes no flag there): no internal route takes the owner rule, so the predicate is
  // read as "never" when the module does not export it, and the base run reaches the behavioural rows below (ASTRA r4 pass 1).
  const { ownerToolExchangeRoute = () => false } = await import("../consuming-turn-response.ts") as { ownerToolExchangeRoute?: (method: string, path: string) => boolean };
  // proxy control or publication, never a tool's answer (SITES.md): GROK-HOLD Q-G3 on whether any of them should take the rule
  const control = ["POST /api/internal/computer-activity", "GET /api/internal/computer-control", "POST /api/internal/computer-control",
    "DELETE /api/internal/computer-control", "GET /api/internal/headless-browser", "POST /api/internal/headless-browser",
    "DELETE /api/internal/headless-browser", "POST /api/internal/tool-result", "POST /api/internal/mcp-catalog/00000000-0000-4000-8000-000000000000",
    "POST /api/internal/mcp-remote/fixture/wipe-metadata", "POST /api/internal/box/v1/boxes/box/resume", "GET /api/internal/box/v1/boxes/box"];
  const routes = [...INTERNAL_HTTP_ROUTES.map(route => `${route.method} ${route.path}`),
    ...PROJECT_ROUTE_NAMES.map(name => `POST /api/internal/project/${name}`), ...EMAIL_ROUTE_NAMES.map(name => `POST /api/internal/email/${name}`),
    "POST /api/internal/mcp-remote/fixture", "GET /api/internal/delegations/abcd", "POST /api/internal/box/v1/boxes/box/commands",
    "GET /api/internal/box/v1/boxes/box/artifacts", "GET /api/internal/box/v1/boxes/box/files",
    "POST /api/internal/mcp-catalog/00000000-0000-4000-8000-000000000000", "POST /api/internal/mcp-remote/fixture/wipe-metadata",
    "POST /api/internal/box/v1/boxes/box/resume", "GET /api/internal/box/v1/boxes/box"];
  const yes = () => true, registry = { project: yes, email: yes, mcp: yes, delegation: yes, box: yes, catalog: yes };
  expect(routes.filter(route => !registeredInternalRoute(route.slice(0, route.indexOf(" ")), route.slice(route.indexOf(" ") + 1), registry)),
    "every row is a route the dispatcher registers").toEqual([]);
  expect(control.filter(route => !routes.includes(route)), "every control row is one of those routes").toEqual([]);
  const judged = (route: string) => ownerToolExchangeRoute(route.slice(0, route.indexOf(" ")), route.slice(route.indexOf(" ") + 1));
  expect(control.filter(judged), "proxy control and publication traffic never takes the owner rule").toEqual([]);
  expect(routes.filter(route => !control.includes(route) && !judged(route)), "a bundled tool's own route stays in the tool exchange").toEqual([]);
  // an allowlist: a route or method nobody named keeps the refusal
  expect(["POST /api/internal/fixture-new-route", "DELETE /api/internal/agents", "PUT /api/internal/memory/search", "POST /api/internal/box/v1/boxes/box/files",
    "GET /api/internal/mcp-remote/fixture"].filter(judged), "a route not named is not in the tool exchange").toEqual([]);
});

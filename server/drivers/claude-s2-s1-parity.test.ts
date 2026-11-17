import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { SendTurnInput } from "../contracts.ts";
import type { TurnCredentialStore } from "./turn-credentials.ts";
import { CliMountRelay } from "./cli-mount-relay.ts";
// Source fixture from 7c64d71f4 with parameter properties expanded for strip-types.
// Both implementations execute
// in the SAME spy harness; no inferred teardown ordering replaces the oracle.
import { CliMountRelay as S1 } from "./claude-s2-s1-golden-relay.fixture.ts";

const trace = vi.hoisted(() => ({ events: [] as string[], recording: false }));
const record = (event: string) => { if (trace.recording) trace.events.push(event); };
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), createServer: () => {
  const listener = new EventEmitter();
  return Object.assign(listener, {
    listen: (_path: string, done: () => void) => done(),
    close: () => { if (trace.recording) trace.events.push("listener.close"); },
  });
} }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  chmodSync() {}, unlinkSync() {}, statSync: () => ({ gid: 1 }),
}));
vi.mock("./mcp-mounts.ts", () => ({
  assertConsumingMountAdmission() {},
  admittedMcpMount: () => ({ ingress: {
    supervise() {}, seal() { throw new Error("S1 happy settlement must not seal"); },
    retire() { if (trace.recording) trace.events.push("ingress.retire"); },
  } }),
}));
vi.mock("../procs.ts", async original => ({ ...await original<typeof import("../procs.ts")>(),
  killCliTree: (child: ChildProcess & { fixtureName: string }) => {
    if (trace.recording) trace.events.push(`${child.fixtureName}.kill`);
    Object.assign(child, { exitCode: 0, signalCode: null }); child.emit("exit", 0, null);
  },
  awaitCliTreeStopped: async () => { if (trace.recording) trace.events.push("cli.confirm"); return true; },
}));
vi.mock("./chat-mcp-client.ts", async original => ({ ...await original<typeof import("./chat-mcp-client.ts")>(),
  ChatMcpDescendants: class {
    track() {} async ready() { if (trace.recording) trace.events.push("descendants.ready"); }
    async stop() { if (trace.recording) trace.events.push("descendants.confirm"); return true; }
  },
  chatMcpTeardown: () => ({
    markStopRequested() { if (trace.recording) trace.events.push("child.stopping"); },
    async wait() { if (trace.recording) trace.events.push("child.tree.confirm"); return { closeConfirmed: true }; },
  }),
}));
function child(name: string): ChildProcess {
  const stdin = new PassThrough();
  const end = stdin.end.bind(stdin);
  stdin.end = ((...args: Parameters<typeof stdin.end>) => { record(`${name}.stdin.end`); return end(...args); }) as typeof stdin.end;
  return Object.assign(new EventEmitter(), { fixtureName: name, stdin, stdout: new PassThrough(), stderr: new PassThrough(),
    pid: undefined, exitCode: null, signalCode: null }) as unknown as ChildProcess;
}
async function capture(Relay: typeof CliMountRelay | typeof S1, engine: string) {
  trace.events = []; trace.recording = false;
  const cli = child("cli");
  const cred = { path: "/isolated-s2-parity/cred", write() {}, clear() { record("cred.clear"); }, dispose() { record("cred-file.dispose"); } } as unknown as TurnCredentialStore;
  const admission = { mount: (entry: object) => entry, dispose: () => record("admission.dispose") };
  const turn = { threadId: `parity-${engine}`, text: "isolated", mountAdmission: admission } as unknown as SendTurnInput;
  const relay = await Relay.create(turn, { one: { command: "isolated", args: [], env: {} } }, {}, cred, () => child("mount"));
  relay.attach(cli, () => { throw new Error("unexpected seal"); });
  const retire = relay.retire.bind(relay);
  relay.retire = () => { retire(); record(`relay.stopping:${relay.mounts.get("one")!.stopping}`); };
  const close = relay.close.bind(relay);
  relay.close = () => { record("relay.close"); close(); };
  const ticket = relay.ticket;
  trace.recording = true;
  const confirmed = await relay.finish();
  const result = { events: [...trace.events], confirmed, exit: cli.exitCode, signal: cli.signalCode,
    ticketRevoked: relay.ticket !== ticket };
  trace.recording = false;
  return result;
}
afterEach(() => { trace.recording = false; vi.unstubAllEnvs(); });

// The baseline really kills CLI BEFORE confirmation and disposes the cred
// file BEFORE admission. It does not revoke the ticket string. Preserve the
// recorded S1 behaviour, even where the addendum's prose lists another order.
const golden = {
  events: ["ingress.retire", "ingress.retire", "relay.stopping:true", "child.stopping", "descendants.ready",
    "mount.stdin.end", "mount.kill", "ingress.retire", "cli.stdin.end", "cli.kill", "cli.confirm", "child.tree.confirm",
    "descendants.confirm", "cred.clear", "cred-file.dispose", "admission.dispose", "relay.close", "listener.close"],
  confirmed: true, exit: 0, signal: null, ticketRevoked: false,
};
// 18 vs 19: R8-C C2 (binding, MC63) adds exactly one shared-capture descendants.ready at the stop request, before child.stopping.
const withC2Capture = (events: string[]) => { const at = events.indexOf("child.stopping"); return [...events.slice(0, at), "descendants.ready", ...events.slice(at)]; };
it.each(["claude-unsupported", "codex"])("T-S2-S1-PARITY: %s, two independent processes against 7c64d71f4", async engine => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  for (let run = 0; run < 2; run++) {
    const baseline = await capture(S1, engine);
    expect(baseline).toEqual(golden);
    expect(await capture(CliMountRelay, engine)).toEqual({ ...baseline, events: withC2Capture(baseline.events) });
  }
});

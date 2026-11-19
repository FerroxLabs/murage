// SPDX-License-Identifier: AGPL-3.0-or-later
// Production warm-S2 witnesses (nativecrash r4 items 5, 9). XT-CL (item 5): production warm S2 reuse. Turn N ends with an open elicitation card; N+1 is dispatched from N's turn.completed after a takeover.
// (1) N+1 survives, (2) N's retirement reply precedes N+1 dispatch, (3) N's card gets exactly one request.resolved even when the gate writes no bytes.
import { steerBuilt, fencedRefusals as ringRefusals, refusalFor, type FencedRefusal } from "./engine-input.ts";
const fencedRefusals = () => ringRefusals() as readonly unknown[] as readonly FencedRefusal[];
import { fencedTurnInput } from "./engine-input.ts";
import { buildPrompt, promptPart, noneRef } from "../memory/prompt-parts.ts";
import { checkedOpenTurns } from "../memory/lineage-write.ts";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDirs } from "../config.ts";
import { ClaudeDriver, permissionSocketPath, resetClaudeMcpReadinessForTests } from "./claude.ts";
import { resetClaudeVersionGate } from "./claude-guards.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createMcpMountAdmission } from "./mcp-mounts.ts";
import { recordEvents } from "../testing/events.ts";
import { claudeS2SteerAdapter } from "./claude-s2-pending.ts";
import type { SendTurnInput } from "../contracts.ts";
import { ClaudeStdinGate } from "./cli-stdin.ts";
import { connect } from "node:net";

// The executable is an isolated wire-protocol fixture, so qualification is
// an explicit injected receipt at this I/O edge, never an ambient test unlock.
vi.mock("./claude-s2-qualification.ts", async original => {
  const actual = await original<typeof import("./claude-s2-qualification.ts")>();
  const receipt = { platform: "linux" as const, arch: "fixture", version: "0.0.0",
    build: "0".repeat(64), evidence: "isolated-wire-fixture" };
  const qualified = () => actual.claudeS2Qualified({}, receipt.platform,
    receipt.version, receipt.build, receipt.arch, [receipt]);
  // Inject the isolated protocol receipt at both identity I/O edges.
  return { ...actual, claudeS2QualifiedCli: async () => qualified(), claudeS2QualifiedCliNow: qualified };
});
vi.mock("./process-tree.ts", async original => ({ ...await original<typeof import("./process-tree.ts")>(),
  descendantBaseline: async () => new Set<number>(), untrackedDescendants: async () => new Set<number>(),
}));
const s2Order = vi.hoisted(() => [] as string[]);
vi.mock("./claude-s2-pending.ts", async original => {
  const api = await original<typeof import("./claude-s2-pending.ts")>();
  return { ...api, beginClaudeS2Pending: (...a: Parameters<typeof api.beginClaudeS2Pending>) => {
    const h = api.beginClaudeS2Pending(...a); const close = h.close.bind(h);
    return { ...h, close: () => { s2Order.push("s2.close"); close(); } };
  } };
});
const xtOrder = vi.hoisted(() => [] as string[]);
vi.mock("./cli-stdin-eof.ts", async original => {
  const api = await original<typeof import("./cli-stdin-eof.ts")>();
  return { ...api, cliStdinEnd: (s: any) => { xtOrder.push(`end:${s.child?.pid}`); return api.cliStdinEnd(s); } };
});
const heldKill = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined, release: () => {} }));
const stdinProbe = vi.hoisted(() => ({ write: undefined as undefined | ((wire: string) => void) }));
vi.mock("../procs.ts", async original => {
  const api = await original<typeof import("../procs.ts")>();
  // CLK held kill: while held, no stop is issued or confirmed for any process; the stop signal waits for the release, then the real kill runs.
  const heldStop = (child: any) => heldKill.gate!.then(() => { (api.killCliTree as any)(child); return api.cliTreeStoppedSignal(child); });
  return { ...api, awaitCliTreeStopped: (...a: Parameters<typeof api.awaitCliTreeStopped>) => heldKill.gate ? Promise.resolve(false) : api.awaitCliTreeStopped(...a),
    forceCliTreeStopped: (...a: Parameters<typeof api.forceCliTreeStopped>) => heldKill.gate ? Promise.resolve(false) : api.forceCliTreeStopped(...a),
    cliTreeStoppedSignal: (child: any) => heldKill.gate ? heldStop(child) : api.cliTreeStoppedSignal(child),
    killCliTree: (child: any, ...r: any[]) => { if (heldKill.gate) { xtOrder.push(`held-kill:${child?.pid}`); return; } xtOrder.push(`kill:${child?.pid}`); return (api.killCliTree as any)(child, ...r); }, spawnCli: (...args: Parameters<typeof api.spawnCli>) => {
    const child = api.spawnCli(...args);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: any, ...rest: any[]) => {
      stdinProbe.write?.(String(chunk)); xtOrder.push(`write:${child.pid}:${String(chunk).slice(0, 400).trim()}`);
      return (write as any)(chunk, ...rest);
    }) as typeof child.stdin.write;
    return child;
  } };
});
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  heldKill.release(); heldKill.gate = undefined;
  stdinProbe.write = undefined;
  vi.unstubAllEnvs(); resetClaudeMcpReadinessForTests(); resetClaudeVersionGate();
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 20_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("S2 production fixture deadline"); await new Promise(r => setTimeout(r, 10)); }
}
async function fixture(fail: boolean, incoming?: string, unsupported = false, onFirst?: (instance: any, turn: (t: string) => SendTurnInput, ev: any, bindings: any[]) => void, refuseFirst = false) {
  ensureDirs(); // server/testing/setup.ts owns the isolated test data HOME
  const root = mkdtempSync(join(tmpdir(), "s2-production-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, "claude.mjs");
  const runtime = readFileSync(new URL("claude-s2-runtime-cli.fixture.mjs", import.meta.url), "utf8");
  // The copied executable still loads the real process-visibility helper;
  // its repository-relative import cannot resolve from a temporary directory.
  writeFileSync(cli, runtime.replace('if (++prompts === 1 && String(frame.message.content).includes("first")) {',
    'if (++prompts === 1 && String(frame.message.content).includes("first")) { if (process.env.FAKE_CLAUDE_S2_ELICIT) out({ type: "control_request", request_id: "xtcl-el", request: JSON.parse(process.env.FAKE_CLAUDE_S2_ELICIT) });').replace('stop_reason: "end_turn", total_cost_usd: 0 });\n    }', 'stop_reason: "end_turn", total_cost_usd: 0 });\n    } else if (String(JSON.stringify(frame.message.content)).includes("second")) { out({ type: "assistant", message: { content: [{ type: "text", text: "done2" }] } }); out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0 }); } else if (String(JSON.stringify(frame.message.content)).includes("late-ok")) { const late = setInterval(() => { if (!existsSync(process.env.FAKE_CLAUDE_S2_RELEASE + "-late")) return; clearInterval(late); out({ type: "assistant", message: { content: [{ type: "text", text: "late" }] } }); out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0 }); }, 20); }').replace('  appendFileSync(process.env.FAKE_CLAUDE_S2_LOG,',
    '  // CL7 slow child: the receipt of the "second" prompt is held until the test releases it (a loaded host, a cold spawn)\n  if (process.env.FAKE_CLAUDE_S2_HOLD_SECOND === "1" && frame.type === "user" && JSON.stringify(frame.message.content).includes("second")) while (!existsSync(process.env.FAKE_CLAUDE_S2_RELEASE + "-second")) await new Promise(r => setTimeout(r, 10));\n  appendFileSync(process.env.FAKE_CLAUDE_S2_LOG,').replace('import "../../shared/win-hide-child-process.mjs";',
    `import ${JSON.stringify(new URL("../../shared/win-hide-child-process.mjs", import.meta.url).href)};\nif (process.env.FAKE_CLAUDE_S2_IGNORE_TERM === "1") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000); }`));
  chmodSync(cli, 0o755);
  const log = join(root, "stdin.jsonl"), release = join(root, "release");
  const failChild = join(root, "fail-one-mount");
  const mountCode = `const fs=require('node:fs'); const flag=${JSON.stringify(failChild)}; if(fs.existsSync(flag)){fs.unlinkSync(flag);process.exit(1);} process.stdin.resume(); let said=false; setInterval(()=>{ if(!said&&fs.existsSync(flag+'-say')){ said=true; process.stdout.write('{}\\n'); } },20);`;
  vi.stubEnv("FAKE_CLAUDE_S2_LOG", log); vi.stubEnv("FAKE_CLAUDE_S2_RELEASE", release);
  vi.stubEnv("FAKE_CLAUDE_S2_FAIL", fail ? "1" : "0"); vi.stubEnv("FAKE_CLAUDE_S2_INCOMING", incoming ?? "");
  vi.stubEnv("FAKE_CLAUDE_S2_UNSUPPORTED", unsupported ? "1" : "0");
  vi.stubEnv("CLAUDE_CONFIG_DIR", root); vi.stubEnv("MURAGE_CLOUD_ROLE", "");
  const instance = await ClaudeDriver.create({ instanceId: randomUUID(), displayName: "isolated S2", enabled: true,
    environment: { FAKE_CLAUDE_S2_LOG: log, FAKE_CLAUDE_S2_RELEASE: release,
      FAKE_CLAUDE_S2_FAIL: fail ? "1" : "0", FAKE_CLAUDE_S2_INCOMING: incoming ?? "",
      FAKE_CLAUDE_S2_UNSUPPORTED: unsupported ? "1" : "0", FAKE_CLAUDE_S2_ELICIT: process.env.XTCL_ELICIT ?? "", FAKE_CLAUDE_S2_IGNORE_TERM: process.env.S2_IGNORE_TERM ?? "", FAKE_CLAUDE_S2_HOLD_SECOND: process.env.S2_HOLD_SECOND ?? "" }, config: { cli, permissionMode: "acceptEdits" } });
  const events = recordEvents(instance.adapter);
  const bindings: Array<ReturnType<typeof consumingFixture>> = [];
  cleanup.push(() => { for (const f of bindings) f.close(); });
  cleanup.push(async () => { events.stop(); await instance.dispose(); });
  const threadId = randomUUID(), botId = randomUUID();
  function turn(text: string): SendTurnInput {
    const f = consumingFixture(undefined, { threadId, botId }); bindings.push(f);
    const caps = new InternalCapabilities(); caps.begin(botId, threadId, f.binding.identity.dispatchGeneration);
    // a tools run (CL1-S2-OWNER) needs the local permission broker, which a draft-only turn never gets
    const input: SendTurnInput = { text, threadId, cwd: root, ...(process.env.S2_TOOLS === "1" ? {} : { draftOnly: true as const }), releaseBinding: f.binding,
      mountAdmission: createMcpMountAdmission(f.binding, createProxyReleaseAuthority(caps), "http://127.0.0.1:1"),
      integrations: { composio: { command: process.execPath, args: ["-e", mountCode], env: {} } } };
    return fencedTurnInput({ ...input, prompt: buildPrompt(f.turn, [promptPart(input.text, [noneRef("owner-turn")])]) },
      { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! });
  }
  const rows = (): Array<{ pid: number; frame: any }> => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
  let firstId = "";
  if (onFirst) cleanup.push(instance.adapter.onEvent((ev: any) => { if (ev.turnId === firstId && ev.threadId === threadId) onFirst(instance, turn, ev, bindings); }));
  // CLSUB: the ledger is revoked BEFORE the first turn's launch, so the launch's own fence refuses it
  if (refuseFirst) { const input = turn("first"); bindings.at(-1)!.flip(); const refused = await instance.adapter.sendTurn(input).then(() => undefined, (e: unknown) => e);
    return { instance, events, turn, rows, pid: 0, threadId, release, failChild, bindings, refused }; }
  const first = await instance.adapter.sendTurn(turn("first")); firstId = first.turnId;
  await events.until(e => e.type === "turn.completed" && e.turnId === first.turnId);
  await expect.poll(() => rows().find(r => r.frame.type === "user"), {
    timeout: 20_000, message: "S2 production fixture must receive the first user frame",
  }).toBeDefined();
  const userFrame = rows().find(r => r.frame.type === "user");
  expect(userFrame, "S2 production fixture first user frame").toBeDefined();
  const pid = userFrame!.pid;
  return { instance, events, turn, rows, pid, threadId, release, failChild, bindings, refused: undefined as unknown };
}
const XTCL_ELICIT = { subtype: "elicitation", mcp_server_name: "fixturesrv", display_name: "Fixture", message: "Run it?", mode: "form", elicitation_id: "el-1",
  requested_schema: { type: "object", properties: { confirm: { type: "boolean", title: "Run it" } }, required: ["confirm"] }, property_order: ["confirm"] };
it("XT-CL r4.5: N's retirement reply is issued before N+1 takes any process; N+1 completes unharmed; N's card resolved once", async () => {
  vi.stubEnv("XTCL_ELICIT", JSON.stringify(XTCL_ELICIT)); vi.stubEnv("FAKE_CLAUDE_S2_ELICIT", JSON.stringify(XTCL_ELICIT));
  // synchronous boundary of N's retirement reply: the stdin gate route call that carries N's elicitation response (cliStdinWrite :32)
  const route = ClaudeStdinGate.prototype.route;
  ClaudeStdinGate.prototype.route = function (frame: any) { const r = route.call(this, frame);
    if (String(frame?.wire).includes("xtcl-el") && String(frame?.wire).includes("control_response")) xtOrder.push(`N.reply:${r}`); return r; };
  cleanup.push(() => { ClaudeStdinGate.prototype.route = route; });
  let second: Promise<unknown> | undefined; let n1Binding: any;
  const x = await fixture(false, undefined, false, (instance, turn, ev, bindings) => {
    if (ev.type === "turn.completed" && !second) {
      const input = turn("second"); n1Binding = bindings.at(-1);
      bindings[0].replace(); // production takeover (index.ts:20686)
      xtOrder.push("N+1.dispatch");
      second = instance.adapter.sendTurn(input).catch((e: unknown) => `threw:${String(e)}`);
    }
  });
  await until(() => !!second);
  setTimeout(() => writeFileSync(x.release, "release"), 300);
  const outcome = await second;
  const n1Id = typeof outcome === "object" ? (outcome as any)?.turnId : undefined;
  // N+1 SURVIVAL first: await its own successful terminal
  let n1Done: any;
  try { await x.events.until((e: any) => e.type === "turn.completed" && e.turnId === n1Id); n1Done = x.events.events.find((e: any) => e.type === "turn.completed" && e.turnId === n1Id); } catch { n1Done = null; }
  await new Promise(r => setTimeout(r, 1000));
  const userSecond = xtOrder.findIndex(o => o.startsWith("write:") && o.includes('"type":"user"') && o.includes("second"));
  const n1Pid = userSecond > -1 ? Number(xtOrder[userSecond]!.split(":")[1]) : -1;
  const firstN1Write = xtOrder.findIndex((o, i) => i > xtOrder.indexOf("N+1.dispatch") && o.startsWith("write:"));
  const replyAt = xtOrder.findIndex(o => o.startsWith("N.reply:"));
  const n1KilledBeforeEnd = xtOrder.filter(o => o === `kill:${n1Pid}` || o === `end:${n1Pid}`).length;
  const facts = { outcome: typeof outcome === "string" ? outcome.slice(0, 80) : "sent", n1Done: n1Done ? { ok: n1Done.ok, stopReason: n1Done.stopReason } : null,
    n1OnP: n1Pid === x.pid, n1Refusals: n1Binding?.refusals, nRefusals: x.bindings[0]!.refusals, replyAt, dispatchAt: xtOrder.indexOf("N+1.dispatch"), firstN1Write,
    n1ClosedOrKilled: n1KilledBeforeEnd, resolved: x.events.events.filter((e: any) => e.type === "request.resolved").length,
    order: xtOrder.map(o => { const m = /^(write|kill|end):(\d+)(?::(.*))?$/s.exec(o); if (!m) return o; const who = Number(m[2]) === x.pid ? "P" : Number(m[2]) === n1Pid ? "Q" : m[2];
      if (m[1] !== "write") return `${m[1]}:${who}`; let fr: any = {}; try { fr = JSON.parse(m[3]!); } catch { return `w:${who}:?`; }
      return `w:${who}:${fr.type}:${fr.request?.subtype ?? fr.response?.request_id ?? (typeof fr.message?.content === "string" ? fr.message.content : "")}`; }) };
  // (1) N+1 survival (before any card check): N+1 ends ok, no refusal against its binding, its process not closed or killed by N
  expect.soft(n1Done, "N+1 turn.completed observed").toBeTruthy();
  expect.soft(n1Done?.ok, "N+1 completed ok").toBe(true);
  expect.soft(n1Binding?.refusals, "no refusal against N+1's binding").toBe(0);
  expect.soft(n1KilledBeforeEnd, "N+1's process never closed or killed").toBe(0);
  // (2) retirement ORDER (discriminating): N's reply is issued before N+1 is dispatched, hence before any N+1 byte on any process
  expect.soft(replyAt, "N's retirement reply issued").toBeGreaterThan(-1);
  expect.soft(replyAt < facts.dispatchAt, "N's retirement reply precedes N+1 dispatch").toBe(true);
  // (3) F11 (d): the card gets exactly one terminal resolution even when no bytes are written
  expect.soft(facts.resolved, "N's elicitation card resolved exactly once").toBe(1);
}, 60_000);

// CLS2 / item 9 P9-REFUSAL: a revoke lands while the S2 barrier holds the second prompt and a steer. The prompt is refused at the cold/warm
// release: no bytes, the steer resolves false, ONE refusal record is written at claude.s2.prompt (read before any Stop check, CLX) and its
// teardown is the retirement of the kept child, confirmed.
it("CLS2 P9-REFUSAL: a revoke at the S2 barrier records one refusal and retires the kept child", async () => {
  const x = await fixture(false);
  const input = x.turn("second"); const f = x.bindings.at(-1)!;
  const sent = x.instance.adapter.sendTurn(input);
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  const prompt = buildPrompt(f.turn, [promptPart("held-owner-text", [noneRef("owner-turn")])]);
  const steer = steerBuilt(claudeS2SteerAdapter(x.threadId)!, x.threadId, prompt, { db: f.f.db, retained: f.turn, reader: checkedOpenTurns(f.turn)[0]!.reader! });
  f.flip();
  writeFileSync(x.release, "release");
  const outcome = await sent.then(() => "sent", (e: unknown) => `threw:${String((e as Error)?.message ?? e).slice(0, 80)}`);
  const steered = await steer;
  await new Promise(r => setTimeout(r, 500));
  const mine = fencedRefusals().filter(r => r.threadId === x.threadId);
  expect(outcome).toBe("threw:MEMORY_CONTEXT_REVOKED");
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content), "no bytes after the revoke").toEqual(["first"]);
  expect(steered).toBe(false);
  expect(mine.map(r => [r.site, r.kind, r.closer])).toEqual([["claude.s2.prompt", "submission", "driver"]]);
  expect(await (mine[0] as any).teardown, "kept child retirement confirmed").toEqual({ confirmed: true });
  expect(() => process.kill(x.pid, 0), "kept child is gone").toThrow();
}, 60_000);

// CLK / N2 F-late on the CLS2 rig: the kept child's stop cannot be confirmed (held kill). The refusal's ONE close reads the session's stop
// verdict: unconfirmed, and it never flips to confirmed. When the stop is proven later, the same record is confirmed late (what lifts the
// lease's thread block), and only then is the child gone.
it("CLK F/late: a held kill leaves the CLS2 refusal unconfirmed; the later stop confirms it late, never as a second close", async () => {
  const x = await fixture(false);
  const input = x.turn("second"); const f = x.bindings.at(-1)!;
  const sent = x.instance.adapter.sendTurn(input);
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  heldKill.gate = new Promise<void>(resolve => { heldKill.release = resolve; });
  f.flip();
  writeFileSync(x.release, "release");
  expect(await sent.then(() => "sent", (e: unknown) => `threw:${String((e as Error)?.message ?? e).slice(0, 80)}`)).toBe("threw:MEMORY_CONTEXT_REVOKED");
  const mine = fencedRefusals().filter(r => r.threadId === x.threadId);
  expect(mine.map(r => [r.site, r.kind, r.closer])).toEqual([["claude.s2.prompt", "submission", "driver"]]);
  const R = mine[0]!;
  expect(await R.teardown, "the stop was not confirmed: the close says so").toEqual({ confirmed: false, reason: "timeout" });
  expect(xtOrder.some(l => l === `held-kill:${x.pid}`), "the kept child's kill was the held one").toBe(true);
  expect(R.lateConfirmedAt, "nothing is confirmed while the kill is held").toBeNull();
  heldKill.release();
  await until(() => { try { process.kill(x.pid, 0); return false; } catch { return true; } });
  await expect.poll(() => R.lateConfirmedAt, { timeout: 5_000, message: "the proven stop confirms the same record late" }).not.toBeNull();
  expect(await R.teardown, "the close result itself never flips").toEqual({ confirmed: false, reason: "timeout" });
}, 60_000);

// CL7b/CL7c (item 9): a held steer is drained after the prompt through steerFenceHolds. A fenced refusal raised by its fence must be
// RECORDED (one steer-scoped submission record at the drain's site, M16 quote-only), never swallowed into a bare resolve(false); no steer
// bytes, the turn itself runs on and its child is not retired.
const refusedSteerFence = () => { throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" }); };
it.each([[false, "claude.stdin.postwarm"], [true, "claude.stdin.cold"]] as const)("CL7 steer drain: a fenced steer is recorded once at its drain site (cold=%s)", async (fail, site) => {
  const x = await fixture(fail);
  const sent = x.instance.adapter.sendTurn(x.turn("second"));
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  let armed = false;
  const held = claudeS2SteerAdapter(x.threadId)!.steer(x.threadId, "fenced-steer", () => { if (armed) refusedSteerFence(); });
  armed = true;
  writeFileSync(x.release, "release");
  await sent;
  expect(await held).toBe(false);
  const mine = fencedRefusals().filter(r => r.threadId === x.threadId);
  expect(mine.map(r => [r.site, r.kind]), "one steer-scoped record at the drain site").toEqual([[site, "submission"]]);
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content), "no steer bytes").toEqual(["first", "second"]);
}, 60_000);

// M16 (CLW/CL7): when the turn's OWN lease already holds the refusal (lease refused -> kind turn), the drained steer's refusal JOINS that
// one record (joins += the drain site), never a second submission record; no steer bytes.
// slow=true holds the child's receipt of "second" past the drain (the repetition-3 failure: a loaded host, a freshly spawned cold child).
it.each([[false, "claude.stdin.postwarm", false], [true, "claude.stdin.cold", false], [false, "claude.stdin.postwarm", true], [true, "claude.stdin.cold", true]] as const)("CL7 M16: a lease-refused steer joins the turn's one record at its drain site (cold=%s, site=%s, slow child=%s)", async (fail, site, slow) => {
  if (slow) vi.stubEnv("S2_HOLD_SECOND", "1");
  const x = await fixture(fail);
  const input = x.turn("second"); const f = x.bindings.at(-1)!;
  const sent = x.instance.adapter.sendTurn(input);
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  let armed = false;
  const held = claudeS2SteerAdapter(x.threadId)!.steer(x.threadId, "fenced-steer", () => { if (armed) refusedSteerFence(); });
  const own = refusalFor(refusedSteerFence_error(), "lease.ledger", { engine: "claude", threadId: x.threadId, binding: f.binding, kind: "turn", target: undefined })!;
  armed = true;
  writeFileSync(x.release, "release");
  const second = await sent;
  expect(await held).toBe(false);
  const mine = fencedRefusals().filter(r => r.threadId === x.threadId);
  expect(mine.map(r => [r.site, r.kind]), "the turn's one record, no steer-scoped submission").toEqual([["lease.ledger", "turn"]]);
  expect(mine[0]).toBe(own);
  expect(own.joins, "the drain site joined").toContain(site);
  if (slow) writeFileSync(x.release + "-second", "release");
  // The child logs a frame on receipt, before its result: the turn's completion orders the read after "second" (no timing assumption).
  await x.events.until(e => e.type === "turn.completed" && e.turnId === second.turnId);
  expect(xtOrder.filter(o => o.startsWith("write:") && o.includes("fenced-steer")), "no steer bytes on any stdin").toEqual([]);
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content), "no steer bytes").toEqual(["first", "second"]);
}, 60_000);
function refusedSteerFence_error(): Error { return Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" }); }

// CLSUB: a fenced refusal at the launch's own fence (before any process exists) is ONE submission record at "claude.prompt.launch"; no
// engine bytes, the caller gets the refusal itself (rethrown unchanged), and no process is left behind.
it("CLSUB launch: a revoke before the first launch records one submission refusal at claude.prompt.launch", async () => {
  const x = await fixture(false, undefined, false, undefined, true);
  expect(x.refused, "the caller still gets the fenced refusal").toBeDefined();
  const mine = fencedRefusals().filter(r => r.threadId === x.threadId);
  expect(mine.map(r => [r.site, r.kind]), "one submission record at the launch fence").toEqual([["claude.prompt.launch", "submission"]]);
  expect(x.rows().filter(r => r.frame.type === "user"), "no prompt bytes").toEqual([]);
}, 60_000);

// A second turn that stays live on the kept (warm S2) child: the fixture answers "first" and "second" only.
async function heldTurn(text: string) {
  const x = await fixture(false);
  const input = x.turn(text); const f = x.bindings.at(-1)!;
  const sent = x.instance.adapter.sendTurn(input);
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  writeFileSync(x.release, "release");
  const started = await sent;
  await until(() => x.rows().filter(r => r.frame.type === "user").length === 2);
  const ended = () => x.events.events.filter((e: any) => e.type === "turn.completed" && e.turnId === started.turnId).map((e: any) => [e.ok, e.stopReason]);
  const gone = () => { try { process.kill(x.pid, 0); return false; } catch { return true; } };
  return { ...x, f, turnId: started.turnId, ended, gone };
}
// CLK mount (G0-LLM consumer): a ledger denial BEFORE a mount frame enters seals the relay with the refusal itself. The claude consumer
// claims it at once for the turn (site claude.mount, target null: no driver close, the LEASE closes it); the process is retired and the
// turn ends memory-refused (P1), once.
it("CLK mount: a pre-entry ledger denial on a mount frame is claimed at claude.mount for the lease and the turn ends memory-refused", async () => {
  const x = await heldTurn("held");
  x.f.flip();
  writeFileSync(x.failChild + "-say", "1");
  await until(x.gone);
  await until(() => x.ended().length > 0);
  await new Promise(r => setTimeout(r, 300));
  const mine = fencedRefusals().filter(r => r.threadId === x.threadId);
  expect(mine.map(r => [r.site, r.kind, r.closer, r.termination]), "one turn record, claimed for the lease").toEqual([["claude.mount", "turn", "lease", "in-process"]]);
  expect(x.ended(), "one terminal, memory-refused").toEqual([[false, "memory-refused"]]);
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content), "no further prompt bytes").toEqual(["first", "held"]);
}, 60_000);

// CLP P1 / CLR (M4 ATTACH, M7 LATE-OK, I2 "late-end"): a turn refusal the LEASE registered (no driver site claim) is found by the
// settle's first statement. Whatever ends the turn afterwards (a late successful `result`, the child's exit) ends it memory-refused,
// never ok. A refusal joined to a lease settles in lease mode: recorded, no driver turn.completed (the lease's refuseTurn is the terminal).
it.each([["late-result", false], ["exit", false], ["stop", false], ["dispose", false], ["held-stop", false], ["late-result", true]] as const)("CLP P1 / CLR: after a lease-registered turn refusal a %s ends the turn memory-refused (lease mode=%s)", async (how, leaseMode) => {
  const x = await heldTurn("late-ok");
  const own = refusalFor(refusedSteerFence_error(), "lease.ledger", { engine: "claude", threadId: x.threadId, binding: x.f.binding, kind: "turn", target: undefined, ...(leaseMode ? { lease: {} } : {}) })!;
  // CLP variants: a driver dispose, and a Stop whose kill is held (no stop is confirmed while held) both end the turn memory-refused
  if (how === "held-stop") heldKill.gate = new Promise<void>(r => { heldKill.release = r; });
  if (how === "dispose") void x.instance.dispose();
  else if (how === "held-stop") void x.instance.adapter.interruptTurn(x.threadId, x.turnId);
  else if (how === "exit") process.kill(x.pid, "SIGKILL"); else if (how === "stop") void x.instance.adapter.interruptTurn(x.threadId, x.turnId); else writeFileSync(x.release + "-late", "1");
  if (leaseMode) {
    await until(() => x.events.events.some((e: any) => e.type === "item.completed" && e.turnId === x.turnId && e.text === "late"));
    await new Promise(r => setTimeout(r, 1_000));
    expect(x.ended(), "lease mode: the driver emits no turn.completed").toEqual([]);
  } else {
    await until(() => x.ended().length > 0);
    await new Promise(r => setTimeout(r, 300));
    expect(x.ended(), "one terminal, memory-refused").toEqual([[false, "memory-refused"]]);
  }
  expect(fencedRefusals().filter(r => r.threadId === x.threadId), "the lease's one record, no second").toEqual([own]);
  // the held stop is released here, so the late confirmation frees the thread before teardown disposes the driver
  if (how === "held-stop") { heldKill.release(); heldKill.gate = undefined; await until(x.gone); }
}, 60_000);

// N2 behaviour check: an unconfirmed retire quarantines at once (no 5 s close timer), so a HEALTHY close must not be read as unconfirmed.
// The kept child ignores SIGTERM: its stop is confirmed only after the SIGTERM grace, by the forced kill, inside the caller deadline.
// That retire is confirmed (never a quarantine, never a late confirmation), and the thread takes its next turn on a fresh process.
it("N2 no false quarantine: a retire confirmed after the SIGTERM grace is a confirmed close, and the thread's next turn runs", async () => {
  vi.stubEnv("S2_IGNORE_TERM", "1");
  const x = await fixture(false);
  const input = x.turn("second"); const f = x.bindings.at(-1)!;
  const sent = x.instance.adapter.sendTurn(input);
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  f.flip();
  const at = Date.now();
  writeFileSync(x.release, "release");
  expect(await sent.then(() => "sent", (e: unknown) => `threw:${String((e as Error)?.message ?? e).slice(0, 80)}`)).toBe("threw:MEMORY_CONTEXT_REVOKED");
  const R = fencedRefusals().filter(r => r.threadId === x.threadId)[0]!;
  expect(await R.teardown, "a stop confirmed inside the deadline is a confirmed close").toEqual({ confirmed: true });
  expect(Date.now() - at, "the child really ignored SIGTERM: the confirmation came from the forced kill").toBeGreaterThanOrEqual(2_500);
  expect(R.lateConfirmedAt, "never a late confirmation").toBeNull();
  expect(() => process.kill(x.pid, 0), "kept child is gone").toThrow();
  const next = await x.instance.adapter.sendTurn(x.turn("first"));
  await x.events.until(e => e.type === "turn.completed" && e.turnId === next.turnId);
  expect(x.events.events.filter((e: any) => e.type === "turn.completed" && e.turnId === next.turnId).map((e: any) => e.ok), "not quarantined: the next turn completes").toEqual([true]);
  expect(x.rows().filter(r => r.frame.type === "user").at(-1)!.pid, "on a fresh process").not.toBe(x.pid);
}, 60_000);

// CL1-S2-OWNER (STAGE2 CL1-4, Fl#12): kept.turn is null while the S2 submission waits in its barrier, so a fenced local broker reply there
// has no live SessionTurn. Its owner is that S2 submission: the barrier ends at once, the submission throws the refusal (ONE record, joined
// at claude.s2.prompt), the driver's composite retires the kept child confirmed, and no cold successor starts under the revoked binding.
// held=true: the kept child's kill is held, so the child stays alive and the barrier's own control request never ends: only the owner's
// settle can end the submission before the 15 s barrier deadline; the close is unconfirmed and confirmed late once the stop is proven.
it.each([false, true])("CL1-S2-OWNER: a fenced broker reply during the S2 barrier settles the S2 submission and retires the kept child (held kill=%s)", async held => {
  vi.stubEnv("S2_TOOLS", "1");
  const x = await fixture(false);
  const socketPath = permissionSocketPath(x.threadId);
  const input = x.turn("second"); const f = x.bindings.at(-1)!;
  const sent = x.instance.adapter.sendTurn(input).then(() => "sent", (e: unknown) => `threw:${String((e as Error)?.message ?? e).slice(0, 80)}`);
  await until(() => x.rows().some(r => r.frame.request?.subtype === "mcp_reconnect"));
  if (held) heldKill.gate = new Promise<void>(resolve => { heldKill.release = resolve; });
  f.flip();
  const sock = connect(socketPath); sock.on("error", () => {}); cleanup.push(() => sock.destroy());
  let sockClosed = false; sock.on("close", () => { sockClosed = true; });
  expect(await new Promise<string>(resolve => { sock.once("connect", () => resolve("connected")); sock.once("error", e => resolve(`error ${String(e).slice(0, 120)} at ${socketPath}`)); }),
    "the broker socket accepts the ask connection").toBe("connected");
  sock.write(JSON.stringify({ t: "ask", id: "s2-barrier-ask", kind: "permission", tool: "Bash", input: { command: "ls" } }) + "\n");
  // the barrier is held open (no release file is written): only the refusal's own settle can end this submission
  const mine = () => fencedRefusals().filter(r => r.threadId === x.threadId);
  await expect.poll(() => mine().map(r => [r.site, r.kind, r.closer]), { timeout: 8_000, message: "ONE turn refusal, claimed by the driver" })
    .toEqual([["claude.broker.2", "turn", "driver"]]);
  expect(await Promise.race([sent, new Promise(r => setTimeout(() => r("still waiting in the barrier"), 8_000))]), "the S2 submission ends with the refusal").toBe("threw:MEMORY_CONTEXT_REVOKED");
  expect(mine()[0]!.joins, "the S2 submission joins the same record; no cold successor is dispatched (no claude.prompt.launch)").toEqual(["claude.s2.prompt"]);
  const R = mine()[0]!;
  if (held) {
    expect(await R.teardown, "the held stop is not confirmed: the close says so").toEqual({ confirmed: false, reason: "timeout" });
    heldKill.release();
    await expect.poll(() => R.lateConfirmedAt, { timeout: 8_000, message: "the proven stop confirms the same record late" }).not.toBeNull();
  } else expect(await R.teardown, "kept child retirement confirmed").toEqual({ confirmed: true });
  await until(() => { try { process.kill(x.pid, 0); return false; } catch { return true; } });
  await until(() => sockClosed);
  expect([...new Set(x.rows().map(r => r.pid))], "no cold successor process").toEqual([x.pid]);
  expect(x.rows().filter(r => r.frame.type === "user").map(r => r.frame.message.content), "no bytes after the revoke").toEqual(["first"]);
}, 60_000);

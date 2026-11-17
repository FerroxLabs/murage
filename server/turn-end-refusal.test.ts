import { createTurnCardGate } from "./turn-card-gate.ts";
// One owner sentence per refused turn, chosen by the lease alone: the exact text each port receives from the real createLedgerLease.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLedgerLease } from "./ledger-refusal.ts";
import { createTurnEnd, ENGINE_FALLBACK_TEXT, ownerCopyOk, emitterRefusalLine, LEDGER_REFUSAL_LINE, MCP_CLOUD_UNAVAILABLE_TEXT, MCP_NOT_READY_TEXT, selectTurnEnd, type TurnCause, type TurnEnd } from "./turn-end.ts";
import { SEND_NOTICE_ENGLISH } from "../shared/send-notice.ts";
import { refuseConsumingTurn, type ConsumingTurnBinding } from "./consuming-turn-response.ts";
import { scopedTx } from "./tx-scope.ts";
import { lateMemoryRefusalLine, turnRefusedLine, type TurnRefusedKind } from "./memory/dispatch.ts";

const verdict = { state: "checking", reason: "not-built" } as const;
function rig(attach = true) {
  const settled: { src: string | undefined; end: TurnEnd }[] = [], presented: TurnEnd[] = [], interrupts: string[] = [];
  const lease = createLedgerLease({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
    seal() {}, quarantine() {},
    async interrupt(id) { interrupts.push(id); return true; },
    settle(_reason, _verdict, end) { settled.push({ src: end.kind === "silent" ? undefined : end.line, end }); },
    present(end) { presented.push(end); },
  });
  if (attach) lease.attach("P");
  return { lease, settled, presented, interrupts };
}
const lines = (r: ReturnType<typeof rig>) => ({ settled: r.settled.map(s => s.src), presented: r.presented.map(e => e.kind === "silent" ? null : e.line) });
afterEach(() => vi.restoreAllMocks());

describe("lease picks the one owner sentence", () => {
  it("R1: an MCP cause noted before the ledger refusal gives the MCP sentence in the stored source and the presented line", async () => {
    const r = rig();
    r.lease.noteCause("mcp-cloud-unavailable"); r.lease.onLedgerRefused(verdict);
    expect(lines(r)).toEqual({ settled: [MCP_CLOUD_UNAVAILABLE_TEXT], presented: [MCP_CLOUD_UNAVAILABLE_TEXT] });
    await r.lease.teardownConfirmed; expect(r.interrupts).toEqual(["P"]);
  });
  it("R1 through refuseConsumingTurn(binding, verdict, cause)", () => {
    const r = rig();
    const binding = { noteCause: (c: TurnCause) => r.lease.noteCause(c), onLedgerRefused: (v: typeof verdict) => r.lease.onLedgerRefused(v) } as unknown as ConsumingTurnBinding;
    expect(() => refuseConsumingTurn(binding, undefined, "mcp-cloud-unavailable")).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(lines(r)).toEqual({ settled: [MCP_CLOUD_UNAVAILABLE_TEXT], presented: [MCP_CLOUD_UNAVAILABLE_TEXT] });
  });
  it("a refusal with no cause still says the ledger sentence", () => {
    const r = rig(); r.lease.onLedgerRefused(verdict);
    expect(lines(r)).toEqual({ settled: [LEDGER_REFUSAL_LINE], presented: [LEDGER_REFUSAL_LINE] });
  });
  it("not-ready cause gives the not-ready sentence", () => {
    const r = rig(); r.lease.noteCause("mcp-not-ready"); r.lease.onLedgerRefused(verdict);
    expect(lines(r)).toEqual({ settled: [MCP_NOT_READY_TEXT], presented: [MCP_NOT_READY_TEXT] });
  });
  it("R2: a ledger refusal that settled first keeps its line, and the late MCP cause is logged", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(); r.lease.onLedgerRefused(verdict);
    expect(r.lease.noteCause("mcp-cloud-unavailable")).toBe(false);
    expect(lines(r)).toEqual({ settled: [LEDGER_REFUSAL_LINE], presented: [LEDGER_REFUSAL_LINE] });
    expect(warn).toHaveBeenCalledWith("[turn] late-cause=mcp-cloud-unavailable after=ledger");
  });
  it("R5: owner Stop first gives silence: no stored line, the presenter still runs once, still one full settlement and teardown", async () => {
    const r = rig(); r.lease.noteCause("owner-stop"); r.lease.onLedgerRefused(verdict);
    expect(r.settled).toHaveLength(1); expect(r.settled[0].end).toEqual({ kind: "silent" });
    expect(r.presented).toEqual([{ kind: "silent" }]);
    await r.lease.teardownConfirmed; expect(r.interrupts).toEqual(["P"]); expect(r.lease.state).toBe("settled");
  });
  it("R6: a ledger refusal that settled first keeps its line when Stop arrives late", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(); r.lease.onLedgerRefused(verdict); r.lease.noteCause("owner-stop");
    expect(lines(r)).toEqual({ settled: [LEDGER_REFUSAL_LINE], presented: [LEDGER_REFUSAL_LINE] });
    expect(warn).toHaveBeenCalledWith("[turn] late-cause=owner-stop after=ledger");
  });
  it("R7: an MCP cause first, then Stop, keeps the MCP sentence", () => {
    const r = rig(); r.lease.noteCause("mcp-cloud-unavailable"); r.lease.noteCause("owner-stop"); r.lease.onLedgerRefused(verdict);
    expect(lines(r)).toEqual({ settled: [MCP_CLOUD_UNAVAILABLE_TEXT], presented: [MCP_CLOUD_UNAVAILABLE_TEXT] });
  });
  it("an admission notice alone is presented as the notice, and the MCP cause beats it", () => {
    const a = rig(false); a.lease.admissionNotLaunched("toolTurnRefused"); a.lease.onLedgerRefused(verdict);
    expect(a.presented).toEqual([{ kind: "notice", notice: "toolTurnRefused", line: SEND_NOTICE_ENGLISH.toolTurnRefused }]);
    const b = rig(false); b.lease.admissionNotLaunched("toolTurnRefused"); b.lease.noteCause("mcp-cloud-unavailable"); b.lease.onLedgerRefused(verdict);
    expect(lines(b)).toEqual({ settled: [MCP_CLOUD_UNAVAILABLE_TEXT], presented: [MCP_CLOUD_UNAVAILABLE_TEXT] });
  });
  it("a refusal inside a writer transaction persists the frozen line even when a cause arrives before the commit", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig();
    scopedTx(() => {
      r.lease.onLedgerRefused(verdict);
      r.lease.noteCause("mcp-cloud-unavailable");
      expect(r.settled).toEqual([]);
    });
    expect(lines(r)).toEqual({ settled: [LEDGER_REFUSAL_LINE], presented: [LEDGER_REFUSAL_LINE] });
    expect(warn).toHaveBeenCalledWith("[turn] late-cause=mcp-cloud-unavailable after=ledger");
  });
  it("every selector output keeps the copy rules", () => {
    const outputs = [selectTurnEnd(["mcp-cloud-unavailable"], undefined, {}), selectTurnEnd(["mcp-not-ready"], undefined, {}),
      selectTurnEnd([], undefined, { verdict }), selectTurnEnd([], "toolTurnRefused", { verdict })];
    for (const end of outputs) {
      const line = end.kind === "silent" ? "" : end.line;
      expect(line).not.toMatch(/[–—]|\b(safe|unsafe|safety|free|forge|will fail)\b/i);
    }
  });
});

describe("owner Stop is recorded at its own boundaries only", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("Stop on a thread whose lease then refuses gives silence with full settlement; a ledger refusal first keeps its line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stopped = rig(), refused = rig();
    const leases = new Map([["G-stop", stopped.lease], ["G-ledger", refused.lease]]);
    const directRuns = new Map([["T-stop", { generation: "G-stop" }], ["T-ledger", { generation: "G-ledger" }]]);
    // The production function text, run over this scope.
    const start = source.indexOf("function noteOwnerStop("), text = source.slice(start, source.indexOf("\n}\n", start) + 2);
    const ts = (await import("typescript")).default;
    const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const note = new Function("directRuns", "internalTurnOwners", "admittedLedgerLeases", "turnCardGate", `${js}\nreturn noteOwnerStop;`)(directRuns, new Map(), leases, createTurnCardGate()) as (threadId: string) => void;
    refused.lease.onLedgerRefused(verdict);
    note("T-stop"); note("T-ledger"); note("T-unknown");
    stopped.lease.onLedgerRefused(verdict);
    expect(stopped.presented).toEqual([{ kind: "silent" }]); expect(stopped.settled.map(s => s.end)).toEqual([{ kind: "silent" }]);
    await stopped.lease.teardownConfirmed; expect(stopped.interrupts).toEqual(["P"]);
    expect(lines(refused)).toEqual({ settled: [LEDGER_REFUSAL_LINE], presented: [LEDGER_REFUSAL_LINE] });
    expect(warn).toHaveBeenCalledWith("[turn] late-cause=owner-stop after=ledger");
  });
});

describe("MC63 fail closed: a silent owner-Stop refusal still interrupts the lease's own turn", async () => {
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const failClosed = "    if (!r || adopted) return fallback().then(result => result.confirmed);\n";
  // the lease is built from the shipped module, or from a copy with the fail-closed interrupt skipped (the MUTANT)
  async function leaseModule(mutant: boolean): Promise<typeof import("./ledger-refusal.ts")> {
    if (!mutant) return import("./ledger-refusal.ts");
    const text = readFileSync(new URL("./ledger-refusal.ts", import.meta.url), "utf8");
    expect(text).toContain(failClosed);
    const dir = mkdtempSync(join(tmpdir(), "ledger-refusal-mutant-"));
    const file = join(dir, "ledger-refusal.mutant.ts");
    const base = new URL(".", import.meta.url).pathname;
    writeFileSync(file, text.replace(failClosed, "    if (!r) return Promise.resolve(false);\n    if (adopted) return r.teardown.then(result => result.confirmed);\n")
      .replace(/from "\.\//g, `from "${base}`));
    try { return await import(/* @vite-ignore */ file); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it.each([["shipped", false], ["MUTANT interrupt skipped", true]] as const)("%s", async (_name, mutant) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { createLedgerLease: create } = await leaseModule(mutant);
    const make = () => {
      const interrupts: string[] = [];
      const lease = create({ botId: "B", threadId: "T", dispatchGeneration: "G", lineageTurnIds: ["L"], adapterLeaseId: "G" }, {
        seal() {}, quarantine() {}, settle() {}, present() {}, async interrupt(id) { interrupts.push(id); return true; },
      });
      lease.attach("P");
      return { lease, interrupts };
    };
    const refused = make(), stopped = make();
    refused.lease.onLedgerRefused(verdict);
    stopped.lease.noteCause("owner-stop");
    stopped.lease.onLedgerRefused(verdict);
    expect(stopped.lease.frozenEnd?.kind).toBe("silent");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(refused.interrupts).toEqual(["P"]);
    expect(stopped.interrupts).toEqual(mutant ? [] : ["P"]);
  });
});

describe("driver emitters take their line from the lease's frozen result", async () => {
  const { readFileSync } = await import("node:fs");
  const emitted = (r: ReturnType<typeof rig>) => emitterRefusalLine({ turnEnd: () => r.lease.end() });
  it("MCP then ledger: the driver's own line is the MCP sentence; ledger alone is L; Stop is no line; no lease is L", () => {
    const a = rig(); a.lease.noteCause("mcp-cloud-unavailable"); a.lease.onLedgerRefused(verdict);
    expect(emitted(a)).toBe(MCP_CLOUD_UNAVAILABLE_TEXT);
    const b = rig(); b.lease.onLedgerRefused(verdict); expect(emitted(b)).toBe(LEDGER_REFUSAL_LINE);
    const c = rig(); c.lease.noteCause("owner-stop"); c.lease.onLedgerRefused(verdict); expect(emitted(c)).toBeUndefined();
    expect(emitterRefusalLine(undefined)).toBe(LEDGER_REFUSAL_LINE);
  });
  it("the driver emitter and the presenter agree on the frozen line even when the emitter runs first", () => {
    const r = rig(); r.lease.noteCause("mcp-cloud-unavailable");
    expect(emitted(r)).toBe(MCP_CLOUD_UNAVAILABLE_TEXT);
    r.lease.onLedgerRefused(verdict);
    expect(lines(r)).toEqual({ settled: [MCP_CLOUD_UNAVAILABLE_TEXT], presented: [MCP_CLOUD_UNAVAILABLE_TEXT] });
  });
  it.each([["acp/core.ts", 2]])("%s keeps no ledger literal in its emitters and routes %i through the lease", (file, count) => {
    const text = readFileSync(new URL(`./drivers/${file}`, import.meta.url), "utf8");
    expect(text).not.toContain("LEDGER_REFUSAL_LINE");
    expect(text.match(/emitterRefusalLine\(turn\.releaseBinding\)/g)).toHaveLength(count);
  });
});

describe("the cause is noted once at its origin", async () => {
  it("noting the same cause at the origin and again at the refusal gives one entry, and a late one logs once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = rig(); r.lease.noteCause("mcp-cloud-unavailable"); r.lease.noteCause("mcp-cloud-unavailable"); r.lease.onLedgerRefused(verdict, "mcp-cloud-unavailable");
    expect(lines(r)).toEqual({ settled: [MCP_CLOUD_UNAVAILABLE_TEXT], presented: [MCP_CLOUD_UNAVAILABLE_TEXT] });
    expect(warn.mock.calls.filter(call => String(call[0]).startsWith("[turn] late-cause"))).toEqual([]);
    const late = rig(); late.lease.onLedgerRefused(verdict); late.lease.noteCause("mcp-cloud-unavailable"); late.lease.noteCause("mcp-cloud-unavailable");
    expect(warn.mock.calls.filter(call => String(call[0]).startsWith("[turn] late-cause"))).toEqual([["[turn] late-cause=mcp-cloud-unavailable after=ledger"]]);
  });
});

describe("engine text is guarded; Murage's own lines are not", () => {
  const warnedWithheld = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(c => c[0] === "[turn] engine-text-withheld").length;
  it.each(["Engine said no \u2014 try later", "range 2\u20133 failed", "unsafe request", "do it safely", "a safer path", "unsafely", "the free tier", "Forge refused", "this will fail"])(
    "withholds %j: the owner sees the fallback and one engine-text-withheld is logged", text => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(createTurnEnd().freeze({ engineText: text })).toEqual({ kind: "engine", line: ENGINE_FALLBACK_TEXT });
      expect(warnedWithheld(warn)).toBe(1);
    });
  it.each(["please re-run", "freedom", "forged", "Fixture engine said no."])("passes %j through verbatim", text => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createTurnEnd().freeze({ engineText: text })).toEqual({ kind: "engine", line: text });
    expect(warnedWithheld(warn)).toBe(0);
  });
  it("a host line is verbatim, even from a registered engine name, and outranks engine text; a ledger verdict outranks both", () => {
    expect(createTurnEnd().freeze({ hostLine: "The mounted tool connection stopped.", engineText: "unsafe" })).toEqual({ kind: "engine", line: "The mounted tool connection stopped." });
    expect(createTurnEnd().freeze({ hostLine: "h", engineText: "e", verdict })).toEqual({ kind: "ledger", line: LEDGER_REFUSAL_LINE });
  });
  it("every host line passes the copy rules for every engine name, plus M, N, L, P1, P2 and the fallback", () => {
    const engines = ["Claude", "Codex", "pi", "Muse Code", "Google Gemini (Antigravity)", "Cursor", "Grok", "Grok (API)", "Cline", "Qwen", "GitHub Copilot", "DeepSeek Harness", "Gemini",
      "Kimi", "Hermes", "Droid", "OpenClaw", "Custom (ACP)", "MiniMax (API)", "OpenCode", "Computer", "the Cloud computer", "Fixture"];
    const kinds: TurnRefusedKind[] = ["without-memory", "without-memory-checking", "without-memory-unknown", "not-started", "after-submission", "after-submission-uncertain", "unknown-submission", "resend-offer"];
    const bad: string[] = [];
    for (const engine of engines) {
      const lineSet = [...kinds.map(kind => turnRefusedLine(engine, kind)), lateMemoryRefusalLine(engine), `${engine} did not start this turn`, `${engine} could not finish this turn.`];
      for (const line of lineSet) if (!ownerCopyOk(line)) bad.push(line);
    }
    for (const line of [MCP_CLOUD_UNAVAILABLE_TEXT, MCP_NOT_READY_TEXT, LEDGER_REFUSAL_LINE, "Murage keeps this bot's memory out of Pi's tools.", SEND_NOTICE_ENGLISH.toolTurnRefused,
      ENGINE_FALLBACK_TEXT, "The mounted tool connection stopped."]) if (!ownerCopyOk(line)) bad.push(line);
    expect(bad).toEqual([]);
  });
});

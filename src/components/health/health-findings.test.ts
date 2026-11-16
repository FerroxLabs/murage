// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HEALTH-DOCTOR (Sean 11-02): one finding per thing to fix, in a fixed order of impact (Flux Router and Fuigo first),
// an engine nobody uses never red, and a top line that says how many and where to start.
import { describe, expect, it, vi } from "vitest";
import { en } from "@/locales";
import type { EngineHealthRow } from "@/components/shell/shell-contract";
import type { HealthFold } from "../../../shared/health-levels";
import type { HealthIssue } from "../../../shared/sentinel-view";
import { FLUX_NOT_READY_COPY } from "../../../shared/provider-error";
import { checkArea, fluxFindings, fluxPanelLine, healthFindings, otherEngines, summaryLine, usedEngines, type FindingEntry } from "./health-findings";
import { answersRunning, askYourBot, backUpNow, recheckFlux, switchEngineOn } from "@/lib/health-actions";

const row = (id: string, state: EngineHealthRow["state"], usedBy = 0, extra: Partial<EngineHealthRow> = {}): EngineHealthRow => ({ id, label: id[0]!.toUpperCase() + id.slice(1), state, line: "", usedBy, ...extra });
const fold = (titleKey: string, level: "act" | "watch" | "note"): HealthFold<HealthIssue> => ({ titleKey, level, issues: 1, count: 1, firstSeenAt: 0, lastSeenAt: 0, rows: [] } as unknown as HealthFold<HealthIssue>);
const keys = (entries: FindingEntry[]) => entries.map((entry) => (entry.kind === "finding" ? entry.finding.key : entry.fold.titleKey));
const base = { engines: [] as EngineHealthRow[], primaryId: null as string | null, flux: "ok" as const, folds: [] as HealthFold<HealthIssue>[], desktop: true, now: Date.parse("2026-11-03T12:00:00Z") };

// Sean's 11-02 list: Fuigo default, Claude used, Kimi/Cursor/pi never installed, droidAgent switched off and unused.
const seans = [row("fuigo", "ready", 2, { fuigo: true }), row("claude", "ready", 3), row("kimi", "missing"), row("cursor", "missing"), row("pi", "missing"), row("droidAgent", "off")];

describe("which engines are findings", () => {
  it("never makes a finding of an engine no bot uses that is not the default: Sean's list has nothing to fix", () => {
    expect(healthFindings({ ...base, engines: seans, primaryId: "fuigo" })).toEqual([]);
    expect(otherEngines(seans, "fuigo").map((r) => r.id)).toEqual(["kimi", "cursor", "pi", "droidAgent"]);
    expect(usedEngines(seans, "fuigo").map((r) => r.id)).toEqual(["claude"]);
  });

  it("is red for a switched off or missing engine a bot uses, and the fix for off is Switch on", () => {
    const entries = healthFindings({ ...base, engines: [row("codex", "off", 2), row("kimi", "missing", 1)], primaryId: "fuigo" });
    const [off, missing] = entries.map((entry) => (entry.kind === "finding" ? entry.finding : null));
    expect(off).toMatchObject({ level: "act", area: 3, fix: { kind: "do", action: "switch-on", engineId: "codex" } });
    expect(off?.matters).toContain("2 bots");
    expect(missing).toMatchObject({ level: "act", fix: { kind: "go", section: "engines" } });
  });

  it("the default engine counts even with no bot on it, and comes before other engines", () => {
    expect(keys(healthFindings({ ...base, engines: [row("codex", "signed-out", 4), row("claude", "signed-out")], primaryId: "claude" }))).toEqual(["engine-signed-out:claude", "engine-signed-out:codex"]);
  });

  it("Fuigo is never signed out (Flux Router speaks for it); a Fuigo that will not start sits at the top with Flux", () => {
    expect(healthFindings({ ...base, engines: [row("fuigo2", "signed-out", 1, { fuigo: true })], primaryId: "fuigo" })).toEqual([]);
    const entries = healthFindings({ ...base, engines: [row("claude", "signed-out"), row("fuigo", "missing", 3, { fuigo: true })], primaryId: "claude" });
    expect(keys(entries)).toEqual(["engine-missing:fuigo", "engine-signed-out:claude"]);
  });

  it("a switched off Fuigo bots use comes before another default engine", () => {
    const entries = healthFindings({ ...base, engines: [row("claude", "off"), row("fuigo", "off", 2, { fuigo: true })], primaryId: "claude" });
    expect(entries.map((entry) => entry.kind === "finding" && entry.finding.area)).toEqual([1, 2]);
  });

  it("an engine at its limit is worth a look, with a step and Ask your bot", () => {
    const [entry] = healthFindings({ ...base, engines: [row("claude", "limit", 1)], primaryId: "fuigo" });
    expect(entry).toMatchObject({ kind: "finding", finding: { level: "watch", fix: { kind: "step" } } });
    expect(entry?.kind === "finding" && entry.finding.ask).toBeTruthy();
  });
});

describe("the order of impact", () => {
  it("puts Flux Router first, then the default engine, engines, backups, disk writes and memory learning", () => {
    const entries = healthFindings({
      ...base, primaryId: "claude", flux: "allowance-used-up",
      engines: [row("codex", "off", 1), row("claude", "signed-out")],
      folds: [fold("health.extraction.unusable-replies", "watch"), fold("health.io-pressure.sustained-writes", "watch"), fold("health.backup.overdue", "act"), fold("health.resets.loop", "note")],
    });
    expect(keys(entries)).toEqual(["flux-used-up", "engine-signed-out:claude", "engine-off:codex", "health.backup.overdue", "health.io-pressure.sustained-writes", "health.extraction.unusable-replies"]);
  });

  it("notes are never findings and never counted", () => {
    expect(healthFindings({ ...base, folds: [fold("health.resets.loop", "note")] })).toEqual([]);
    expect(checkArea("health.something.new")).toBe(10);
  });
});

describe("Flux Router findings", () => {
  const now = base.now;
  it("a key problem goes to Models; used up gives the step and Check again", () => {
    expect(fluxFindings("key-problem", null, true, now)[0]).toMatchObject({ level: "act", fix: { kind: "go", section: "models" } });
    expect(fluxFindings("allowance-used-up", null, true, now)[0]).toMatchObject({ level: "act", fix: { kind: "step", then: "flux-recheck" } });
  });

  it("on a Cloud home a key problem says the approved line, offers no Models button, and checks again", () => {
    const [finding] = fluxFindings("key-problem", null, true, now, true);
    expect(finding).toMatchObject({ level: "act", title: FLUX_NOT_READY_COPY, fix: { kind: "step", then: "flux-recheck" } });
    expect(JSON.stringify(finding)).not.toMatch(/Flux key|Models|"go"/);
    expect(fluxPanelLine("key-problem", null, true)).toBe(FLUX_NOT_READY_COPY);
    expect(fluxPanelLine("key-problem", null, false)).toBe(en["ux.l2a.health.flux.keyProblem" as keyof typeof en]);
  });

  it("warns at 80% used and within 7 days of the key expiring, and not before", () => {
    expect(fluxFindings("ok", { spendPct: 79, expires: null }, true, now)).toEqual([]);
    expect(fluxFindings("ok", { spendPct: 80, expires: null }, true, now).map((f) => f.key)).toEqual(["flux-80"]);
    expect(fluxFindings("ok", { spendPct: null, expires: "2026-11-09T12:00:00Z" }, true, now).map((f) => f.key)).toEqual(["flux-expires"]);
    expect(fluxFindings("ok", { spendPct: null, expires: "2026-11-11T12:00:00Z" }, true, now)).toEqual([]);
    expect(fluxFindings("ok", null, true, now)).toEqual([]);
  });

  it("the phone names no place to pay (store rule)", () => {
    for (const finding of [...fluxFindings("allowance-used-up", null, false, now), ...fluxFindings("ok", { spendPct: 95, expires: "2026-11-04T00:00:00Z" }, false, now)]) {
      expect(finding.fix.kind).toBe("step");
      expect(en[(finding.fix as { step: keyof typeof en }).step]).not.toMatch(/fluxrouter|top up|renew/i);
    }
  });

  it("the panel line says Checking until valid figures come in, never a stale number", () => {
    expect(fluxPanelLine("ok", null)).toBe(en["ux.l2a.health.flux.checking"]);
    expect(fluxPanelLine("ok", { spendPct: 42, expires: null })).toContain("42%");
    expect(fluxPanelLine("none", { spendPct: 42, expires: null })).toBe(en["ux.l2a.health.flux.none"]);
  });
});

describe("the top line", () => {
  it("counts the findings and names where to start", () => {
    const entries = healthFindings({ ...base, flux: "key-problem", engines: [row("codex", "off", 2)], primaryId: "fuigo" });
    expect(summaryLine(entries, () => "")).toBe("2 things to fix. Start with Flux Router.");
    expect(summaryLine(entries.slice(1), () => "")).toBe("1 thing to fix: Codex.");
    expect(summaryLine(healthFindings({ ...base, folds: [fold("health.backup.overdue", "act")] }), () => "")).toBe("1 thing to fix: Backups.");
    expect(summaryLine([], () => "")).toBeNull();
  });
});

describe("every new string", () => {
  it("is in the English pack, in plain words: no em dash, never safe or free", () => {
    const fresh = Object.entries(en).filter(([key]) => key.startsWith("ux.l2b.health.doc.") || key.startsWith("ux.l2b.health.ask.") || key.startsWith("ux.l2b.health.do.") || /^ux\.l2a\.health\.(summary|flux|word|area|bots|otherEngines|enginesUsed|checked|findings|fluxName|fluxCard|setUp|signIn|switchOn|checkAgain|backUpNow|askBot)/.test(key));
    expect(fresh.length).toBeGreaterThan(60);
    for (const [, text] of fresh) {
      expect(text).not.toMatch(/—/);
      expect(text).not.toMatch(/\b(safe|free)\b/i);
    }
  });
});

describe("the one-tap fixes", () => {
  it("Switch on waits while answers are running and never sends then", async () => {
    const call = vi.fn(async () => ({}));
    expect(await switchEngineOn("codex", true, call, async () => {})).toBe(en["ux.l2b.health.do.busy"]);
    expect(call).not.toHaveBeenCalled();
    expect(answersRunning({ bots: [{ tasks: [{ busy: true }] }], groups: [] })).toBe(true);
    expect(answersRunning({ bots: [{}], groups: [{ working: false }] })).toBe(false);
  });

  it("Switch on sends the Settings PATCH once, says busy on a 409 and never retries by itself", async () => {
    const call = vi.fn(async () => ({}));
    expect(await switchEngineOn("codex", false, call, async () => {})).toBe(en["ux.l2b.health.do.switchedOn"]);
    expect(call).toHaveBeenCalledWith("/api/instances/codex?whenIdle=1", { method: "PATCH", body: JSON.stringify({ enabled: true }) }, 1);
    const busy = vi.fn(async () => { throw Object.assign(new Error("busy"), { status: 409 }); });
    expect(await switchEngineOn("codex", false, busy, async () => {})).toBe(en["ux.l2b.health.do.busy"]);
    expect(busy).toHaveBeenCalledTimes(1);
  });

  it("Check again posts once and reads the answer again", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const refresh = vi.fn(async () => true);
    expect(await recheckFlux(call, refresh)).toBe(en["ux.l2b.health.do.checked"]);
    expect(call).toHaveBeenCalledWith("/api/engine-health/recheck", { method: "POST", body: "{}" }, 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // "Checked" only once a new answer came back
    expect(await recheckFlux(call, async () => false)).toBe(en["ux.l2b.health.do.checkFailed"]);
  });

  it("Back up now uses the Backups page's own call and sentences", async () => {
    expect(await backUpNow(undefined)).toBe(en["ux.l2b.health.do.backupHere"]);
    const runNow = vi.fn(async () => ({}));
    const bridge = { status: async () => ({ revision: 7 }), runNow } as unknown as Parameters<typeof backUpNow>[0];
    expect(await backUpNow(bridge)).toBe(en["ux.l2b.health.do.backupStarted"]);
    expect(runNow).toHaveBeenCalledWith(7);
    const busy = { status: async () => ({ revision: 7 }), runNow: async () => { throw new Error("BACKUP_BUSY"); } } as unknown as Parameters<typeof backUpNow>[0];
    expect(await backUpNow(busy)).toBe("A backup is already running.");
  });

  it("Ask your bot opens the Chief's chat with the question in the composer, never sent", () => {
    const select = vi.fn();
    const prefill = vi.fn();
    const bots = [{ id: "b1", threadId: "t1" }, { id: "hidden", threadId: "t0", hidden: true, chiefOfStaff: true, chiefScope: "workspace" as const }, { id: "chief", threadId: "t2", chiefOfStaff: true, chiefScope: "workspace" as const }];
    expect(askYourBot("What are my options?", bots, select, prefill)).toBe(true);
    expect(select).toHaveBeenCalledWith("chief");
    expect(prefill).toHaveBeenCalledWith({ botId: "chief", threadId: "t2" }, "What are my options?");
    expect(askYourBot("x", [], select, prefill)).toBe(false);
  });
});

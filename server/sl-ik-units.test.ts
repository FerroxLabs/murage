// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-K / SL-I: the pure rules behind threads following their bot and a
// limit continuing on another engine. Each test names the owner's failure it prevents.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelSelection } from "./contracts.ts";
import { billingLabel, engineBilling, limitBackupAllowed, routineBackupBilling } from "./limit-backup.ts";
import { LIMIT_WAIT_OPTION, limitCardAnswer, limitOfferCard, limitOutcome, LimitTurns, relayedRefusalText, type LimitTurn } from "./limit-continuation.ts";
import { bootRecovery, effectiveState, LimitFailoverStore, type FailoverRow } from "./limit-failovers.ts";
import { engineFamilyOf, limitRefusal } from "./limit-refusal.ts";
import { engineKey, LIMIT_NO_RESET_MS, LimitStateStore } from "./limit-state.ts";
import { acpEngineErrorCode, acpEngineLimitResetsAt } from "./drivers/acp/core.ts";
import { engineKey as sharedEngineKey, limitEngineOptions } from "../shared/limit-engine-key.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { refreshPreview } from "./thread-permissions-refresh.ts";
import { healedLine, resolveTurnSelection, type RouteVerdict, type TurnSelectionDeps } from "./turn-selection.ts";

const BOT: ModelSelection = { instanceId: "claude", model: "opus" };
const PIN: ModelSelection = { instanceId: "codex", model: "gpt-6-sol", effort: "high" } as ModelSelection;
const BACKUP: ModelSelection = { instanceId: "codex", model: "gpt-6-luna" };
const NOW = Date.UTC(2026, 9, 20, 12);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const tempDir = () => { const root = mkdtempSync(join(tmpdir(), "murage-sl-ik-")); roots.push(root); return root; };

function deps(over: Partial<TurnSelectionDeps> & { refuse?: Record<string, RouteVerdict> } = {}): TurnSelectionDeps {
  return {
    routes: (selection) => over.refuse?.[selection.model] ?? { ok: true },
    failoverRow: () => undefined,
    atLimit: () => false,
    routineBackupAllowed: () => true,
    ...over,
  };
}

describe("K2: one resolver for every turn", () => {
  const bot = { name: "Ember", modelSelection: BOT };
  it("a chat with no pick runs the bot's model; a chat with a pick runs its pick, effort included", () => {
    expect(resolveTurnSelection({}, bot, { routine: false }, NOW, deps()).selection).toEqual(BOT);
    expect(resolveTurnSelection({ modelSelection: PIN }, bot, { routine: false }, NOW, deps()).selection).toEqual(PIN);
  });
  it("a routine reusing a thread the owner pinned still runs on the bot's model (my routine moved when I changed the chat)", () => {
    expect(resolveTurnSelection({ modelSelection: PIN }, bot, { routine: true }, NOW, deps()).selection).toEqual(BOT);
  });
  it("a room member turn (no chat record) uses the bot's model", () => {
    expect(resolveTurnSelection(null, bot, { routine: false }, NOW, deps()).selection).toEqual(BOT);
  });
  it("a pick that is signed out or off heals onto the bot's model with one line and is never cleared", () => {
    const task = { modelSelection: PIN };
    for (const code of ["needs-sign-in", "disabled", "model", "protocol"] as const) {
      const out = resolveTurnSelection(task, bot, { routine: false }, NOW, deps({ refuse: { [PIN.model]: { ok: false, code } } }));
      expect(out.selection).toEqual(BOT);
      expect(out.line).toBe(healedLine("Ember"));
    }
    expect(task.modelSelection).toEqual(PIN);
  });
  it("a pick refused for its limit, or both refused, does not heal: today's refusal words stay", () => {
    expect(resolveTurnSelection({ modelSelection: PIN }, bot, { routine: false }, NOW, deps({ refuse: { [PIN.model]: { ok: false, code: "plan-limit" } } })).selection).toEqual(PIN);
    const both = deps({ refuse: { [PIN.model]: { ok: false, code: "disabled" }, [BOT.model]: { ok: false, code: "disabled" } } });
    const out = resolveTurnSelection({ modelSelection: PIN }, bot, { routine: false }, NOW, both);
    expect(out.selection).toEqual(PIN);
    expect(out.line).toBeUndefined();
  });
  it("a failover past its reset returns the chat to following, or to its own earlier pick", () => {
    const row = (was: FailoverRow["was"], resetsAt: number | null, at = NOW - 10) => ({ rowId: "r1", state: "applied" as const, was, resetsAt, at });
    const following = resolveTurnSelection({ modelSelection: BACKUP, limitFailover: "r1" }, bot, { routine: false }, NOW, deps({ failoverRow: () => row("following", NOW - 1) }));
    expect(following).toMatchObject({ selection: BOT, restore: { rowId: "r1", to: "following" } });
    const pinned = resolveTurnSelection({ modelSelection: BACKUP, limitFailover: "r1" }, bot, { routine: false }, NOW, deps({ failoverRow: () => row(PIN, NOW - 1) }));
    expect(pinned).toMatchObject({ selection: PIN, restore: { to: PIN } });
    // reset still ahead: stays on the backup
    expect(resolveTurnSelection({ modelSelection: BACKUP, limitFailover: "r1" }, bot, { routine: false }, NOW, deps({ failoverRow: () => row("following", NOW + 1) })).selection).toEqual(BACKUP);
    // no reset known: an hour after the move
    expect(resolveTurnSelection({ modelSelection: BACKUP, limitFailover: "r1" }, bot, { routine: false }, NOW, deps({ failoverRow: () => row("following", null, NOW - 59 * 60_000) })).selection).toEqual(BACKUP);
    expect(resolveTurnSelection({ modelSelection: BACKUP, limitFailover: "r1" }, bot, { routine: false }, NOW, deps({ failoverRow: () => row("following", null, NOW - 61 * 60_000) })).restore?.to).toBe("following");
  });
  it("a routine continues on the backup only while the bot's engine is at its limit and routines are allowed", () => {
    const withBackup = { ...bot, limitBackup: { selection: BACKUP, routines: true, at: NOW } };
    expect(resolveTurnSelection({}, withBackup, { routine: true }, NOW, deps()).selection).toEqual(BOT);
    expect(resolveTurnSelection({}, withBackup, { routine: true }, NOW, deps({ atLimit: () => true })).selection).toEqual(BACKUP);
    expect(resolveTurnSelection({}, withBackup, { routine: true }, NOW, deps({ atLimit: () => true, routineBackupAllowed: () => false })).selection).toEqual(BOT);
  });
});

describe("K3: Refresh permissions", () => {
  it("previews the change, copies Full only when the bot is on Full, and unions always-allow", () => {
    const preview = refreshPreview({ autoApprove: true, fullAccess: false, alwaysAllow: ["Bash:git", "Read"] }, { autoApprove: false, alwaysAllow: ["Read", "Web"] });
    expect(preview.level).toEqual({ from: "ask", to: "auto" });
    expect(preview.alwaysAllowAdd).toEqual(["Bash:git"]);
    expect(preview.patch).toEqual({ autoApprove: true, fullAccess: false, noLimits: false, alwaysAllow: ["Read", "Web", "Bash:git"] });
    expect(refreshPreview({ autoApprove: true, fullAccess: true }, {}).patch.fullAccess).toBe(true);
    expect(refreshPreview({ autoApprove: false, fullAccess: true }, {}).patch.fullAccess).toBe(false);
  });
  it("a bot level change after the preview changes the preview id (the stale apply is refused)", () => {
    const a = refreshPreview({ autoApprove: true }, {}), b = refreshPreview({ autoApprove: true, fullAccess: true }, {});
    expect(a.previewId).not.toBe(b.previewId);
    expect(refreshPreview({ autoApprove: true }, {}).previewId).toBe(a.previewId);
  });
});

describe("I1: a limit refusal from every engine", () => {
  const cases: Array<[string, string, { status?: number; text: string }, number | undefined]> = [
    ["claudeAgent", "pipe epoch", { text: "Claude AI usage limit reached|1792497600" }, 1792497600_000],
    ["claudeAgent", "hit your limit", { text: "You've hit your limit · resets 3pm" }, undefined],
    ["codex", "json resets_in_seconds", { text: '{"error":{"type":"usage_limit_reached","resets_in_seconds":600}}' }, NOW + 600_000],
    ["codex", "try again in", { text: "You've hit your usage limit. Try again in 2 hours 5 minutes." }, NOW + 125 * 60_000],
    ["openai-compatible", "429 retry-after", { status: 429, text: "Too Many Requests retry-after: 30" }, NOW + 30_000],
    ["opencodeGo", "QUOTA_EXCEEDED", { text: "error QUOTA_EXCEEDED" }, undefined],
  ];
  it.each(cases)("%s (%s) is a limit, with its reset time when it names one", (driver, _name, refusal, resetsAt) => {
    const out = limitRefusal(engineFamilyOf(driver), refusal, NOW);
    expect(out).not.toBeNull();
    if (resetsAt !== undefined) expect(out!.resetsAt).toBe(resetsAt);
  });
  it("an ordinary error is not a limit", () => {
    expect(limitRefusal("claude", { text: "connection reset by peer" }, NOW)).toBeNull();
    expect(limitRefusal("codex", { status: 500, text: "internal error" }, NOW)).toBeNull();
  });
  it("after the engine did anything, a limit never fails over (the turn ends as it does today)", () => {
    const turns = new LimitTurns();
    const turn: LimitTurn = { botId: "b", threadId: "t", selection: BOT, engineName: "Claude", driverKind: "claudeAgent", viaGateway: false, sendIds: ["s"], sourceMessageId: "m", sourceText: "hi", ownerDirect: true, routine: false, onFailover: false, activity: false };
    turns.begin(turn);
    turns.observe({ type: "turn.started", threadId: "t", turnId: "p1" });
    turns.observe({ type: "content.delta", threadId: "t", turnId: "p1" });
    expect(turns.get("t")!.activity).toBe(true);
    turns.begin({ ...turn, threadId: "u", activity: false, providerTurnId: undefined });
    turns.observe({ type: "item.started", threadId: "u", itemType: "tool", origin: "murage" });
    expect(turns.get("u")!.activity).toBe(false);
  });
  it("text an engine relays counts as its refusal only when the text is itself a short limit refusal (a real answer is model activity)", () => {
    const isLimit = (text: string) => limitRefusal("claude", { text }, NOW) !== null;
    const turns = new LimitTurns();
    turns.begin({ botId: "b", threadId: "c", selection: BOT, engineName: "Claude", driverKind: "claudeAgent", viaGateway: false, sendIds: [], sourceMessageId: "m", sourceText: "hi", ownerDirect: true, routine: false, onFailover: false, activity: false });
    turns.observe({ type: "content.delta", threadId: "c", streamKind: "assistant_text", delta: "Claude AI usage limit reached|1792497600" });
    expect(turns.get("c")!.activity).toBe(false);
    expect(relayedRefusalText(turns.get("c")!, isLimit)).toBe("Claude AI usage limit reached|1792497600");
    expect(relayedRefusalText({ textActivity: true, text: "Here is the plan you asked for." }, isLimit)).toBeNull();
    expect(relayedRefusalText({ textActivity: true, text: `${"x".repeat(1200)} usage limit reached` }, isLimit)).toBeNull();
    expect(relayedRefusalText({}, isLimit)).toBe("");
  });
  it("one hop: a resend from a failover, or a chat already on its backup, only gets the plain line", () => {
    const turn = { routine: false, ownerDirect: true, onFailover: false } as LimitTurn;
    expect(limitOutcome(turn, { resentByFailover: false, backup: BACKUP, backupUsable: true })).toEqual({ kind: "failover", to: BACKUP });
    expect(limitOutcome(turn, { resentByFailover: true, backup: BACKUP, backupUsable: true }).kind).toBe("plain");
    expect(limitOutcome({ ...turn, onFailover: true }, { resentByFailover: false, backup: BACKUP, backupUsable: true }).kind).toBe("plain");
    expect(limitOutcome(turn, { resentByFailover: false, backup: BACKUP, backupUsable: false }).kind).toBe("card");
    expect(limitOutcome({ ...turn, routine: true }, { resentByFailover: false, backupUsable: true }).kind).toBe("none");
    expect(limitOutcome({ ...turn, ownerDirect: false }, { resentByFailover: false, backupUsable: true }).kind).toBe("none");
  });
});

describe("I2: limit-state, epoch ms only", () => {
  it("records a reset per billing identity; no reset known means an hour", () => {
    const dir = tempDir(), store = new LimitStateStore(() => dir);
    const key = engineKey({ instanceId: "claude", connectionId: "acct" });
    expect(key).toBe("connection:acct");
    store.record(key, NOW + 1000, NOW);
    expect(store.atLimit(key, NOW)).toBe(true);
    expect(store.atLimit(key, NOW + 1000)).toBe(false);
    store.record("engine:codex", null, NOW);
    expect(store.atLimit("engine:codex", NOW + LIMIT_NO_RESET_MS - 1)).toBe(true);
    expect(store.atLimit("engine:codex", NOW + LIMIT_NO_RESET_MS)).toBe(false);
  });
});

describe("I4: which backup may take over, and what it bills", () => {
  it("names each billing", () => {
    expect(engineBilling({ instanceId: "claude", model: "opus" }, { driverKind: "claudeAgent" })).toBe("own-subscription");
    expect(engineBilling({ instanceId: "x", model: "m", connectionId: "c" }, { preset: "chatgpt" })).toBe("own-subscription");
    expect(engineBilling({ instanceId: "x", model: "m", connectionId: "c" }, { preset: "openrouter" })).toBe("own-key");
    expect(engineBilling({ instanceId: "x", model: "m", connectionId: "c" }, { preset: "flux" })).toBe("flux");
    expect(engineBilling({ instanceId: "x", model: "m", connectionId: "c" }, {})).toBe("unknown");
    expect(engineBilling({ instanceId: "fuigo", model: "m" }, { driverKind: "fuigoAgent" })).toBe("flux");
    expect(engineBilling({ instanceId: "acp", model: "m" }, { driverKind: "geminiAgent" })).toBe("unknown");
    expect(billingLabel("own-key")).toBe("your key");
  });
  it("Codex flux::flux-auto as a routine backup bills Flux, so routines refuse it and the run waits", () => {
    const billing = engineBilling({ instanceId: "codex", model: "flux::flux-auto" }, { driverKind: "codex" });
    expect(billing).toBe("flux");
    expect(routineBackupBilling(billing)).toBe(false);
    expect(routineBackupBilling("own-subscription")).toBe(true);
    expect(routineBackupBilling("own-key")).toBe(true);
    expect(routineBackupBilling("unknown")).toBe(false);
  });
  it("never two sign-ins of one subscription, never the same engine; a key on the same provider is fine", () => {
    const codexA = { instanceId: "codex", model: "a" }, chatgpt = { instanceId: "x", model: "b", connectionId: "c" };
    expect(limitBackupAllowed(codexA, { driverKind: "codex" }, chatgpt, { preset: "chatgpt" })).toBe(false);
    expect(limitBackupAllowed(codexA, { driverKind: "codex" }, codexA, { driverKind: "codex" })).toBe(false);
    expect(limitBackupAllowed(codexA, { driverKind: "codex" }, { ...chatgpt }, { preset: "openai" })).toBe(true);
    expect(limitBackupAllowed(BOT, { driverKind: "claudeAgent" }, codexA, { driverKind: "codex" })).toBe(true);
  });
});

describe("I4: failover rows and boot recovery", () => {
  const base = { botId: "b", threadId: "t", from: BOT, was: "following" as const, to: BACKUP, at: NOW, sourceMessageId: "m" };
  it("a row is pending until its chat carries it; a chat that dropped it cancels it for good", () => {
    const dir = tempDir(), store = new LimitFailoverStore(() => dir, () => NOW);
    const row = store.create({ ...base, resetsAt: NOW + 60_000 });
    expect(row.state).toBe("pending");
    expect(row.resendSendId).toHaveLength(32);
    expect(effectiveState(row, { modelSelection: BACKUP, limitFailover: row.rowId })).toBe("applied");
    expect(effectiveState({ ...row, state: "applied" }, { modelSelection: PIN })).toBe("cancelled");
    store.cancel(row.rowId);
    expect(store.setState(row.rowId, "applied")!.state).toBe("cancelled");
    expect(store.bySendId(row.resendSendId)!.rowId).toBe(row.rowId);
  });
  it("crash after the row: boot applies while the reset is ahead, else cancels", () => {
    const row = { ...base, rowId: "r", state: "pending", resetsAt: NOW + 60_000, resendSendId: "x".repeat(32), hop: 1 } as FailoverRow;
    expect(bootRecovery([row], () => ({}), () => false, NOW)).toEqual([{ kind: "apply", row }]);
    expect(bootRecovery([row], () => ({}), () => false, NOW + 61_000)).toEqual([{ kind: "cancel", row }]);
    // the owner picked a model meanwhile: never applied
    expect(bootRecovery([row], () => ({ modelSelection: PIN }), () => false, NOW)).toEqual([{ kind: "cancel", row }]);
  });
  it("crash after the patch: boot marks it applied and resends once with the row's own send id", () => {
    const row = { ...base, rowId: "r", state: "pending", resetsAt: NOW + 60_000, resendSendId: "x".repeat(32), hop: 1 } as FailoverRow;
    const chat = { modelSelection: BACKUP, limitFailover: "r" };
    expect(bootRecovery([row], () => chat, () => false, NOW).map(a => a.kind)).toEqual(["mark-applied", "resend"]);
    expect(bootRecovery([{ ...row, state: "applied" }], () => chat, () => true, NOW)).toEqual([]);
    // past the reset: no late resend
    expect(bootRecovery([{ ...row, state: "applied" }], () => chat, () => false, NOW + 61_000)).toEqual([]);
  });
  it("an owner pick then a restart never reapplies the failover", () => {
    const row = { ...base, rowId: "r", state: "applied", resetsAt: NOW + 60_000, resendSendId: "x".repeat(32), hop: 1 } as FailoverRow;
    expect(bootRecovery([row], () => ({ modelSelection: PIN }), () => false, NOW)).toEqual([{ kind: "cancel", row }]);
  });
});

describe("I5: the limit card", () => {
  const card = limitOfferCard({
    requestId: "limit-1", engine: "Claude", until: NOW + 3_600_000, sourceMessageId: "m", from: BOT, resetsAt: NOW + 3_600_000,
    choices: [{ engine: "Codex", selection: BACKUP, billing: "own-subscription" }, { engine: "Fuigo", selection: { instanceId: "fuigo", model: "f" }, billing: "flux" }],
  });
  it("labels every engine with what it bills and always offers Wait", () => {
    expect(card.options).toEqual(["Codex (your plan)", "Fuigo (Flux credit)", LIMIT_WAIT_OPTION]);
  });
  it("only an answer naming a listed engine switches; a decline, free text or dismiss is Wait", () => {
    expect(limitCardAnswer(card.limitOffer, "answer", "Codex (your plan)", { nextTime: true, routines: true })).toMatchObject({ kind: "engine", nextTime: true, routines: true });
    expect(limitCardAnswer(card.limitOffer, "answer", "Codex (your plan)", { routines: true })).toMatchObject({ kind: "engine", nextTime: false, routines: false });
    expect(limitCardAnswer(card.limitOffer, "deny", "Codex (your plan)", {})).toEqual({ kind: "wait" });
    expect(limitCardAnswer(card.limitOffer, "answer", "rm -rf /", {})).toEqual({ kind: "wait" });
    expect(limitCardAnswer(card.limitOffer, "answer", LIMIT_WAIT_OPTION, {})).toEqual({ kind: "wait" });
  });
});

describe("1.0.4 fixes: the picker, structured limits, routine records", () => {
  const instances = [{ instanceId: "claude", displayName: "Claude" }, { instanceId: "codex", displayName: "Codex" }];
  it("M1: a bot on a sign-in or key connection is offered the key its limit is recorded under, first, so its routine can fire", () => {
    const onConnection = { instanceId: "claude", model: "opus", connectionId: "conn-1" };
    const options = limitEngineOptions(onConnection, instances, "connected account");
    expect(options[0].key).toBe(engineKey(onConnection));
    expect(options[0].key).toBe("connection:conn-1");
    expect(options.map(option => option.key)).toEqual(["connection:conn-1", "engine:claude", "engine:codex"]);
    // a bot on a plain engine keeps the old list, its own engine first
    expect(limitEngineOptions({ instanceId: "codex", model: "x" }, instances, "connected account").map(option => option.key)).toEqual(["engine:codex", "engine:claude"]);
    // a saved key that is in neither list is kept, not silently swapped
    expect(limitEngineOptions(undefined, instances, "connected account", "connection:old").map(option => option.key)).toContain("connection:old");
    // the picker and the recorder share one function
    expect(sharedEngineKey).toBe(engineKey);
    // and the page offers that list, not a bare engine list
    const page = readFileSync(join(import.meta.dirname, "..", "src", "components", "RoutineCalendarPage.tsx"), "utf8");
    expect(page).toContain("limitEngineOptions(botSelection");
    expect(page).not.toMatch(/value=\{`engine:\$\{instance\.instanceId\}`\}/);
  });
  it("M2: an ACP engine's structured kind, code and reset time make a limit when its prose is sanitised", () => {
    const prose = "Fuigo could not finish this turn.";
    expect(limitRefusal("acp", { text: prose }, NOW)).toBeNull();
    expect(limitRefusal("acp", { text: prose, kind: "rate_limited" }, NOW)).toEqual({});
    expect(limitRefusal("acp", { text: prose, kind: "empty_response" }, NOW)).toBeNull();
    expect(limitRefusal("acp", { text: prose, kind: "rate_limited", resetsAt: NOW + 90_000 }, NOW)).toEqual({ resetsAt: NOW + 90_000 });
    expect(limitRefusal("opencode-go", { text: "Your plan could not answer.", code: "QUOTA_EXCEEDED" }, NOW)).toEqual({});
    expect(limitRefusal("opencode-go", { text: "Your plan could not answer.", code: "REGION_RESTRICTED" }, NOW)).toBeNull();
    // the driver reads the engine's data, not its text
    expect(acpEngineErrorCode({ code: "QUOTA_EXCEEDED" })).toBe("QUOTA_EXCEEDED");
    expect(acpEngineErrorCode({ code: -32603 })).toBeUndefined();
    expect(acpEngineLimitResetsAt({ resets_in_seconds: 600 }, NOW)).toBe(NOW + 600_000);
    expect(acpEngineLimitResetsAt({ resets_at: 1792497600 }, NOW)).toBe(1792497600_000);
    expect(acpEngineLimitResetsAt({ message: "x" }, NOW)).toBeUndefined();
  });
  it("M2: the turn record keeps the error's structured facts", () => {
    const turns = new LimitTurns();
    turns.begin({ botId: "b", threadId: "g", selection: BOT, engineName: "Gemini", driverKind: "geminiAgent", viaGateway: false, sendIds: [], sourceMessageId: "m", sourceText: "hi", ownerDirect: true, routine: false, onFailover: false, activity: false });
    turns.observe({ type: "runtime.error", threadId: "g", message: "Gemini could not finish this turn.", errorKind: "rate_limited", engineCode: "QUOTA_EXCEEDED", limitResetsAt: NOW + 5000 });
    expect(turns.get("g")).toMatchObject({ errorKind: "rate_limited", engineCode: "QUOTA_EXCEEDED", errorResetsAt: NOW + 5000 });
  });
  it("L2: a routine turn that never hit a limit has its record ended when it settles; another provider turn's event leaves it", () => {
    const turns = new LimitTurns();
    turns.begin({ botId: "b", threadId: "r", selection: BOT, engineName: "Claude", driverKind: "claudeAgent", viaGateway: false, sendIds: [], sourceMessageId: "m", sourceText: "hi", ownerDirect: false, routine: true, onFailover: false, activity: false, providerTurnId: "p1" });
    expect(turns.settle("r", "other")).toBeUndefined();
    expect(turns.get("r")).toBeDefined();
    expect(turns.settle("r", "p1")?.routine).toBe(true);
    expect(turns.get("r")).toBeUndefined();
  });
});

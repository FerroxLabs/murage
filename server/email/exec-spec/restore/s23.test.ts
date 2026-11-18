// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r3.4d-s23 reducer-driven tests: the three restore-reducer changes of 0c2ff570d exercised by driving reduceRestore directly from a seeded state
// (not through the spec predicates). Each test names its mutant (a one-line revert of its change, see s23-mutants.sh) that must turn it red.

import { describe, expect, it } from "vitest";
import type { HomeEvent, HomeState } from "./model.ts";
import { SEEDS } from "./seeds.ts";
import { reduceRestore, renderSeedSurface, restoreReducer } from "./restore-reducer.ts";
import { LOOK_AGAIN_LINE, keepSuccessIsConfirmed } from "./invariants.current.ts";
import { DOMAIN_ONE } from "./domain.ts";
import { enabled, apply } from "./moves.ts";
import { NOOP_CTX } from "./model.ts";

const NOW = 1_000_000;
const drive = (s: HomeState, event: HomeEvent) => { const hits: string[] = []; const r = reduceRestore(s, event, { hit: id => void hits.push(id) }); return { ...r, hits }; };
const ownerResult = (acts: { k: string }[]) => acts.filter(a => a.k === "ownerResult") as { k: "ownerResult"; ok: boolean; code?: string }[];
const P = "owner_desktop" as const;
/** the owner opens the screen: the surface rows (with tokens) the owner actually sees */
const view = (s: HomeState) => drive(s, { e: "owner", nowMs: NOW, action: { t: "owner.viewSurface", principal: P } });
const tokenOf = (s: HomeState, section: string, kind: string): string => { const row = s.surface.find(r => r.section === section && r.visible); const a = row?.actions.find(x => x.kind === kind); if (!a?.tokenId) throw new Error("no " + kind + " token on " + section); return a.tokenId; };
const waitIds = (s: HomeState): string[] => Object.keys((s.local as unknown as { x: { waits: Record<string, unknown> } }).x.waits);

describe("s23 reducer-driven (real restore-reducer.ts)", () => {
  // MUTANT M1 (s23-mutants.sh m1): drop the bot-only refusal in owner.tryAgainNow.
  it("tryAgainNow on a non-bot target is refused with not_a_bot_target, changes nothing and sends nothing", () => {
    const home = SEEDS.midFlightRemoval().home; // lease rm-i1 pending on inbox:i1: without the rule this would be a Try again (ok)
    for (const target of ["inbox:i1", "op:op-b1"]) {
      const r = drive(home, { e: "owner", nowMs: NOW, action: { t: "owner.tryAgainNow", principal: "owner_desktop", botId: "b1", target, outcome: { ok: true } } });
      expect(ownerResult(r.actions)).toEqual([{ k: "ownerResult", ok: false, code: "not_a_bot_target" }]);
      expect(r.hits).toContain("tryAgain.not_bot");
      expect(r.hits).not.toContain("tryAgain.ok");
      expect(r.actions.filter(a => a.k === "send")).toEqual([]);
      expect(r.state.local.leases).toEqual(home.local.leases);
    }
  });

  // MUTANT M2 (s23-mutants.sh m2): Keep success resets only the keeping bot's binding.
  it("Keep success resets EVERY binding on the target (all removing/remove_requested/removal_parked go active, intents cleared)", () => {
    const m = SEEDS.fresh(); // b1 active on i1
    const L = m.home.local;
    const gen = (g: typeof L.bindings.b1.gen, key: string) => ({ ...g, emailKeyRef: key });
    L.bindings.b2 = { botId: "b2", state: "removing", step: null, gen: gen(L.bindings.b1.gen, "k2"), address: "addr:i1" };
    L.bindings.b3 = { botId: "b3", state: "remove_requested", step: null, gen: gen(L.bindings.b1.gen, "k3"), address: "addr:i1" };
    L.bindings.b4 = { botId: "b4", state: "removal_parked", step: null, gen: gen(L.bindings.b1.gen, "k4"), address: "addr:i1" };
    L.bindings.b5 = { botId: "b5", state: "removing", step: null, gen: { inboxId: "i9", opId: "op-b5", emailKeyRef: "k5", serial: 1 }, address: "addr:i9" }; // OTHER target: must stay
    for (const b of ["b2", "b3", "b4", "b5"]) L.intents[b] = { botId: b, inboxId: L.bindings[b].gen.inboxId, keyId: L.bindings[b].gen.emailKeyRef, phase: "committed", deletionProof: false };
    let s = drive(m.home, { e: "owner", nowMs: NOW, action: { t: "owner.keep", principal: "owner_desktop", botId: "b1", target: "inbox:i1", tokenId: null, mode: "live", outcome: { ok: true } } });
    expect(ownerResult(s.actions)).toEqual([{ k: "ownerResult", ok: true }]);
    for (const answerKind of ["RESTORE_INBOX", "GET_INBOX"]) {
      const ids = waitIds(s.state); expect(ids, answerKind).toHaveLength(1);
      s = drive(s.state, { e: "answer", nowMs: NOW + 10, requestId: ids[0], answer: "ok", code: null, fluxStateSeen: "active" });
    }
    expect(s.hits).toContain("answer.kget.success");
    const B = s.state.local.bindings;
    expect(Object.fromEntries(Object.keys(B).map(k => [k, B[k].state]))).toEqual({ b1: "active", b2: "active", b3: "active", b4: "active", b5: "removing" });
    expect(Object.keys(s.state.local.intents)).toEqual(["b5"]);
    expect(s.state.local.keepOps).toEqual({});
  });

  // MUTANT M3 (s23-mutants.sh m3): drop the kept-target refusal in parkBinding.
  it("parkBinding refuses a kept target visibly (park.refused_kept), leaves it unparked, still parks the unkept one", () => {
    const m = SEEDS.legacy1018(); // b1 removing (k1 on i1), b2 remove_requested (k2 on i2), no leases: boot prep parks both as legacy
    m.home.local.keptKeys.k1 = "au:kept"; // i1 was kept
    const r = drive(m.home, { e: "bootPrep", nowMs: NOW, inject: "none" });
    expect(r.hits.filter(h => h === "park.refused_kept")).toHaveLength(1);
    const L = r.state.local;
    expect(L.bindings.b1.state).toBe("removing"); // refused: unchanged, no park row
    expect(L.parks.b1).toBeUndefined();
    expect(L.bindings.b2.state).toBe("removal_parked"); // control: the unkept one parks normally
    expect(L.parks.b2?.origin).toBe("legacy");
  });

  // MUTANT m5: an untokened bot-row Keep on a stale target is admitted (the staleUntokened refusal is off).
  it("an untokened bot-row Keep whose target is not the bot's live row is refused confirm_expired, pure, with the look-again line on the bot row", () => {
    const home = SEEDS.fresh().home; home.surface = renderSeedSurface(home, NOW); // b1 live on inbox:i1; the screen is stale for bot:b1
    const r = drive(home, { e: "owner", nowMs: NOW, action: { t: "owner.keep", principal: P, botId: "b1", target: "bot:b1", tokenId: null, mode: "bot_section", outcome: { ok: true } } });
    expect(ownerResult(r.actions)).toEqual([{ k: "ownerResult", ok: false, code: "confirm_expired" }]);
    expect(r.actions.filter(a => a.k === "authorize" || a.k === "keep" || a.k === "send")).toEqual([]);
    expect(r.state.local.keepOps).toEqual({});
    expect(r.state.surface.find(x => x.visible && x.section === "bot" && x.botId === "b1")?.line).toBe(LOOK_AGAIN_LINE);
  });

  // MUTANT m6: Remove refuses bot_present for every section but the bot's own (the pre-fix rule).
  it("Remove with a valid token from a parked row is admitted; only an other-setup/key-only row of a live binding is refused bot_present", () => {
    const home = SEEDS.fresh().home;
    const seen = view(home).state;
    const tk = tokenOf(seen, "bot", "remove");
    const ok = drive(seen, { e: "owner", nowMs: NOW, action: { t: "owner.remove", principal: P, botId: "b1", target: "inbox:i1", tokenId: tk, section: "parked", outcome: { ok: true } } });
    expect(ownerResult(ok.actions)).toEqual([{ k: "ownerResult", ok: true }]);
    const no = drive(seen, { e: "owner", nowMs: NOW, action: { t: "owner.remove", principal: P, botId: "b1", target: "inbox:i1", tokenId: tk, section: "other_setup", outcome: { ok: true } } });
    expect(ownerResult(no.actions)).toEqual([{ k: "ownerResult", ok: false, code: "bot_present" }]);
  });

  // MUTANT m7: Keep refuses bot_present whenever the mode needs a token (the pre-fix rule).
  it("an orphan Keep with a valid token on a PARKED target is admitted (bot_present needs a live binding on the inbox)", () => {
    const m = SEEDS.legacy1018(); m.home.local.intents = {};
    const parked = drive(m.home, { e: "bootPrep", nowMs: NOW, inject: "none" }).state; // b1, b2 parked as legacy
    const seen = view(parked).state;
    const tk = tokenOf(seen, "parked", "keep");
    const target = seen.surface.find(r => r.section === "parked" && r.visible)!.target as string;
    const botId = seen.surface.find(r => r.section === "parked" && r.visible)!.botId as string;
    const r = drive(seen, { e: "owner", nowMs: NOW, action: { t: "owner.keep", principal: P, botId, target, tokenId: tk, mode: "orphan", outcome: { ok: true } } });
    expect(ownerResult(r.actions)).toEqual([{ k: "ownerResult", ok: true }]);
  });

  // MUTANT m8: a Remove on a target that already holds a lease changes no lease.
  it("a fresh Remove on a target with a held lease re-keys it: ONE lease, new id, naming the new authority, no second DELETE", () => {
    const home = SEEDS.midFlightRemoval().home;
    const seen = view(home).state;
    const tk = tokenOf(seen, "bot", "remove");
    const r = drive(seen, { e: "owner", nowMs: NOW, action: { t: "owner.remove", principal: P, botId: "b1", target: "inbox:i1", tokenId: tk, section: "bot", outcome: { ok: true } } });
    expect(ownerResult(r.actions)).toEqual([{ k: "ownerResult", ok: true }]);
    const auth = (r.actions.find(a => a.k === "authorize") as { authorityId: string }).authorityId;
    const ls = Object.values(r.state.local.leases);
    expect(ls).toHaveLength(1);
    expect(ls[0].removalId).not.toBe("rm-i1");
    expect(ls[0].authorityId).toBe(auth);
    expect(r.actions.filter(a => a.k === "send")).toEqual([]);
  });

  // MUTANT m9: the seed-time surface render returns no rows.
  it("the seed-time surface shows the bot row (address, Keep, Remove) before any step", () => {
    const rows = renderSeedSurface(SEEDS.fresh().home, NOW);
    const row = rows.find(r => r.section === "bot" && r.botId === "b1");
    expect(row?.visible).toBe(true);
    expect(row?.address).toBe("addr:i1");
    expect(row?.actions.map(a => a.kind)).toEqual(["keep", "remove"]);
  });

  // MUTANT m10 (seeds.ts): the seed owner token shows no key ids.
  it("a seed owner token and authority show the bot's key, so a later Keep on that token is not wider than what it showed", () => {
    const m = SEEDS.midFlightRemoval();
    expect(m.env.ghost.tokens[0].shown.keyIds).toEqual(["k1"]);
    expect(m.env.ghost.authorities[0].scope.keyIds).toEqual(["k1"]);
  });

  // MUTANT m11 (moves.ts): the owner is never offered Try again now on a non-bot target.
  it("the move generator offers Try again now on an inbox target (a stale screen), so tryAgain.not_bot is reachable", () => {
    const m = SEEDS.fresh();
    const mv = enabled(m, { domain: DOMAIN_ONE, reducer: restoreReducer, ctx: NOOP_CTX });
    expect(mv.some(x => x.t === "owner.tryAgainNow" && x.target === "inbox:i1")).toBe(true);
    expect(mv.some(x => x.t === "owner.tryAgainNow" && x.target === "bot:b1")).toBe(true);
  });

  // MUTANT m12: a binding is parked even while the owner's Keep is in flight on its target.
  it("an automatic park never takes a binding whose target has the owner's Keep in flight", () => {
    const m = SEEDS.midFlightRemoval().home; // b1 removing on i1, lease from a legacy authority
    const k = drive(m, { e: "owner", nowMs: NOW, action: { t: "owner.keep", principal: P, botId: "b1", target: "inbox:i1", tokenId: null, mode: "bot_section", outcome: { ok: true } } }).state;
    expect(Object.keys(k.local.keepOps)).toHaveLength(1);
    const s = drive(k, { e: "settle", nowMs: NOW + 1 });
    expect(s.state.local.parks.b1).toBeUndefined();
    expect(s.hits).not.toContain("tick.park_unauthorized");
  });

  // MUTANT m13: a p token on a parked row is refused confirm_expired for Remove (the pre-fix rule).
  it("Remove with a parked row's p token is admitted: the park goes remove_authorized and one lease names the new authority", () => {
    const parked = drive(SEEDS.legacy1018().home, { e: "bootPrep", nowMs: NOW, inject: "none" }).state;
    const seen = view(parked).state;
    const tk = tokenOf(seen, "parked", "remove");
    const row = seen.surface.find(r => r.section === "parked" && r.visible)!;
    const r = drive(seen, { e: "owner", nowMs: NOW, action: { t: "owner.remove", principal: P, botId: row.botId, target: row.target as string, tokenId: tk, section: "parked", outcome: { ok: true } } });
    expect(ownerResult(r.actions)).toEqual([{ k: "ownerResult", ok: true }]);
    expect(r.state.local.parks[row.botId as string].state).toBe("remove_authorized");
    expect(Object.values(r.state.local.leases).filter(l => l.botId === row.botId)).toHaveLength(1);
  });

  // MUTANT m14 (moves.ts): a crash before an owner action's write leaves its authority in the ghost.
  it("a crash before an owner Keep's write commits nothing: no authority, no Keep record, and the step is the crash", () => {
    const rt = { domain: DOMAIN_ONE, reducer: restoreReducer, ctx: NOOP_CTX };
    let m = SEEDS.fresh(); m.home.surface = renderSeedSurface(m.home, m.env.nowMs);
    m = apply(m, { t: "fault.crash", at: "W13_keep_claim", when: "before" }, rt).model;
    const r = apply(m, { t: "owner.keep", principal: P, botId: "b1", target: "inbox:i1", tokenId: null, mode: "bot_section", outcome: { ok: true } }, rt);
    expect(r.model.env.ghost.authorities).toHaveLength(0);
    expect(r.model.env.ghost.keeps).toHaveLength(0);
    expect(r.model.home.proc.phase).toBe("down");
    expect(r.steps.map(s => s.action.t)).toEqual(["fault.crash"]);
  });

  // MUTANT m15 (moves.ts): the recorder does not stamp a park into lastParkOrRestoreStep.
  it("a park kills the bot's owner tokens: the recorder stamps lastParkOrRestoreStep at the parking step", () => {
    const rt = { domain: DOMAIN_ONE, reducer: restoreReducer, ctx: NOOP_CTX };
    const r = apply(SEEDS.midFlightRemoval(), { t: "auto.settle" }, rt);
    expect(r.model.home.local.parks.b1).toBeDefined();
    expect(r.model.env.ghost.lastParkOrRestoreStep.b1).toBe(r.model.env.step);
  });

  // MUTANT m16 (s23-mutants.sh m16): the reducer does not stamp parks into x.parkTok (a b token minted before a park revives after the park's Remove).
  it("midFlightRemoval trace: after the park and its p-token Remove, the seed's pre-park b token is refused confirm_expired (token predates the park)", () => {
    const rt = { domain: DOMAIN_ONE, reducer: restoreReducer, ctx: NOOP_CTX };
    let m = SEEDS.midFlightRemoval();
    const seedTok = ["t", "b", 1, 0, m.env.nowMs - 6000, "seed-auth0", "b1", 1, "inbox:i1"].join("|"); // the seed's own token (seeds.ts seedOwnerAuthority format)
    m = apply(m, { t: "auto.settle" }, rt).model;
    m = apply(m, { t: "owner.viewSurface", principal: P }, rt).model;
    const pTok = m.home.surface.find(r => r.section === "parked")?.actions.find(a => a.kind === "remove")?.tokenId as string;
    expect(pTok).toBeTruthy();
    m = apply(m, { t: "owner.remove", principal: P, botId: "b1", target: "inbox:i1", tokenId: pTok, section: "bot", outcome: { ok: true } }, rt).model;
    expect(m.home.local.parks.b1.state).toBe("remove_authorized");
    const r = apply(m, { t: "owner.remove", principal: P, botId: "b1", target: "inbox:i1", tokenId: seedTok, section: "bot", outcome: { ok: true } }, rt);
    expect(r.move).toMatchObject({ t: "owner.remove", outcome: { ok: false, code: "confirm_expired" } });
    expect(r.model.env.ghost.authorities).toHaveLength(m.env.ghost.authorities.length); // no new authority (the seed's own auth0 stays)
    expect(Object.keys(r.model.home.local.leases)).toHaveLength(Object.keys(m.home.local.leases).length);
  });
  // MUTANT m17 (seeds.ts): seed 8 records the first RESTORE answer as ok instead of refused (breaks the replay).
  it("seed keepRetryAfterRefused equals fresh() after owner.viewSurface, owner.keep(live, issued token) and flux.apply r1 through the real apply, and reaches answer.kget.success in 3 more moves", () => {
    const hits: string[] = [], rt = { domain: DOMAIN_ONE, reducer: restoreReducer, ctx: { hit: (id: string) => void hits.push(id) } };
    let m = SEEDS.fresh(); m.home.surface = renderSeedSurface(m.home, m.env.nowMs);
    m = apply(m, { t: "owner.viewSurface", principal: P }, rt).model; // the owner view issues the bot-row token before the Keep
    const tk = m.home.surface.find(r => r.section === "bot" && r.visible)!.actions.find(a => a.kind === "remove")!.tokenId;
    expect(tk).not.toBeNull();
    m = apply(m, { t: "owner.keep", principal: P, botId: "b1", target: "inbox:i1", tokenId: tk, mode: "live", outcome: { ok: true } }, rt).model;
    expect(m.env.ghost.tokens.some(t => t.tokenId === m.env.ghost.authorities[0].tokenId)).toBe(true); // the Keep's authority cites an issued token
    m = apply(m, { t: "flux.apply", requestId: "r1" }, rt).model;
    expect(SEEDS.keepRetryAfterRefused()).toEqual(m);
    let s = SEEDS.keepRetryAfterRefused();
    s = apply(s, { t: "net.answer", requestId: "r1", result: "refused", fluxStateSeen: "active" } as never, rt).model;
    s = apply(s, { t: "flux.apply", requestId: "r2" }, rt).model;
    expect(hits).not.toContain("answer.kget.success");
    const confirmed = apply(s, { t: "net.answer", requestId: "r2", result: "ok", fluxStateSeen: "active" } as never, rt);
    s = confirmed.model;
    const restore = s.env.flux.requests.find(r => r.requestId === "r1")!;
    const get = s.env.flux.requests.find(r => r.requestId === "r2")!;
    expect(restore.answerSeen).toMatchObject({ result: "refused", fluxStateSeen: "active" });
    expect(get.answerSeen).toMatchObject({ result: "ok", fluxStateSeen: "active" });
    expect(get.sentAtStep).toBeGreaterThan(restore.answerSeen!.atStep);
    for (const step of confirmed.steps) expect(keepSuccessIsConfirmed(step.prev, step.action, step.next)).toEqual({ ok: true });
    expect(hits).toContain("answer.kget.success");
    expect(s.home.local.keepOps).toEqual({});
  });
});

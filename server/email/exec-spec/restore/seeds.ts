// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Seed (initial) models. Includes mid-flight and legacy 1.0.18 shapes (removing / remove_requested with no lease, committed intent on
// active, provisioning with no inbox id, foreign lease), not only clean states (A15). Seeds are pure builders of Model.

import type { AuthorityKind, Binding, Ghost, Generation, LocalDb, Lease, RemoteRequest } from "./invariants.current.ts";
import type { Domain } from "./domain.ts";
import { DOMAIN_ONE, DOMAIN_TWO, NO_LIVE_SUFFIX } from "./domain.ts";
import type { FluxConfig, Model } from "./model.ts";

export const emptyLocal = (): LocalDb => ({
  tablesPresent: true, bindings: {}, intents: {}, parks: {}, leases: {}, keepOps: {}, keepGuards: {}, rotations: {}, pendingLifecycle: [], keptKeys: {}, savedKeys: {},
});
export const emptyGhost = (): Ghost => ({ epoch: 0, tokens: [], authorities: [], keeps: [], restores: [], usedKeepOps: [], preparedEpochs: [], inventoryConfirmedEpochs: [], preparedResets: [], lastBootAtMs: 0, lastParkOrRestoreStep: {}, botDeletedAtStep: {}, ownerRestoreRequests: [], keptHighWater: {} });

export function baseModel(d: Domain, cfg: FluxConfig = { listing: "off" }): Model {
  return {
    home: { local: emptyLocal(), carry: null, fs: { liveMarker: null, stagedMarker: null, messagesDbPresent: true }, proc: { processId: 1, phase: "running", emailOn: true }, surface: [], ops: [] },
    env: {
      step: 0, nowMs: 1_000_000, bots: Object.fromEntries(d.bots.map(b => [b, { botId: b, present: true }])),
      flux: { inboxes: {}, keys: {}, requests: [], events: [], semantics: { restoreCredential: "owner", deleteIdempotencyKeyHonoured: true, listingShipped: false } }, archives: [], ghost: emptyGhost(),
      ext: {
        cfg, armed: null, crashes: 0, restores: 0, views: 0, backups: 0, clockJumps: 0, fluxCloses: 0, nextReq: 1, nextEvent: 1, nextAuth: 1, nextArchive: 1,
        archiveDbs: {}, results: {}, emitted: {}, deliveries: {}, mail: {}, lastTickMs: null, settledInProc: null, listingDelivered: false, reqMeta: {}, harnessViolations: [],
      },
    },
  };
}

const gen = (i: string, op: string, k: string): Generation => ({ inboxId: i, opId: op, emailKeyRef: k, serial: 1 });
function addBot(m: Model, bot: string, inbox: string, key: string, state: Binding["state"] = "active"): void {
  const g = gen(inbox, "op-" + bot, key);
  m.home.local.bindings[bot] = { botId: bot, state, step: null, gen: g, address: "addr:" + inbox };
  m.home.local.savedKeys[bot] = key;
  m.env.flux.inboxes[inbox] = { inboxId: inbox, installOwned: true, createdUnderOp: "op-" + bot, forBot: bot, address: "addr:" + inbox, state: "active", closingCause: null, closingSinceMs: null, closingSinceStep: null };
  m.env.flux.keys[key] = { keyId: key, installOwned: true, mintedUnderOp: "op-" + bot, forBot: bot, state: "live" };
}
/** A seed authority is VALID only if a real owner action made it: the token it names was issued to an owner principal for this bot and shown this target. */
export function seedOwnerAuthority(m: Model, authorityId: string, bot: string, inbox: string, kind: AuthorityKind = "remove_bot_section"): void {
  const gen = m.home.local.bindings[bot]?.gen ?? null, target = "inbox:" + inbox, tokenId = ["t", "b", 1, 0, m.env.nowMs - 6000, "seed-" + authorityId, bot, gen?.serial ?? 1, target].join("|"); // the reducer's id format (restore-reducer.ts mintToken), so tokenInfo reads it as live
  m.env.ghost.tokens.push({ tokenId, kind: "b", botId: bot, gen, park: null, shown: { target, address: null, inboxId: inbox, keyIds: gen?.emailKeyRef ? [gen.emailKeyRef] : [] }, issuedTo: "owner_desktop", issuedAtStep: 0, issuedAtMs: m.env.nowMs - 6000, processId: 1, epoch: 0 });
  m.env.ghost.authorities.push({ authorityId, kind, principal: "owner_desktop", tokenId, verifiedAtStep: 0, verifiedAtMs: m.env.nowMs - 5500, verifiedInProcess: 1, epoch: 0, botId: bot, scope: { target, inboxId: inbox, keyIds: gen?.emailKeyRef ? [gen.emailKeyRef] : [] }, genAtVerify: gen, parkAtVerify: null });
}
const heldDelete = (m: Model, inbox: string, id = "r0"): RemoteRequest => {
  seedOwnerAuthority(m, "auth0", m.env.flux.inboxes[inbox].forBot ?? "", inbox);
  const r: RemoteRequest = { requestId: id, copyOf: null, kind: "DELETE_INBOX", purpose: "removal", target: inbox, credential: "owner", removalId: "rm-" + inbox, attemptId: "at1", authorityId: "auth0", keepOp: null, sentAtStep: 0, sentAtMs: m.env.nowMs - 5000, sentInProcess: 1, sentInEpoch: 0, flux: "held", appliedAtMs: null, answer: "pending", answerSeen: null };
  m.env.flux.requests.push(r);
  m.env.ext.reqMeta[id] = { botHint: null, deleteReason: "owner" };
  return r;
};

export const SEEDS: Record<string, (cfg?: FluxConfig) => Model> = {
  fresh: cfg => { const m = baseModel(DOMAIN_ONE, cfg); addBot(m, "b1", "i1", "k1"); return m; },
  /** a removal is in flight: lease unknown, DELETE held at Flux, answer pending (the A1 shape before any restore). */
  midFlightRemoval: cfg => {
    const m = baseModel(DOMAIN_ONE, cfg); addBot(m, "b1", "i1", "k1", "removing");
    const l: Lease = { removalId: "rm-i1", target: "inbox:i1", inboxId: "i1", botId: "b1", authorityId: "auth0", foreign: false, phase: "unknown", attemptId: "at1", attempts: ["at1"], keyTargets: [{ keyId: "k1", status: "pending" }] };
    m.home.local.leases["rm-i1"] = l; m.home.local.intents.b1 = { botId: "b1", inboxId: "i1", keyId: "k1", phase: "committed", deletionProof: false };
    heldDelete(m, "i1"); return m;
  },
  /** 1.0.18 states: removing / remove_requested with NO lease row (pre-preparation shapes). */
  legacy1018: cfg => {
    const m = baseModel(DOMAIN_TWO, cfg); addBot(m, "b1", "i1", "k1", "removing"); addBot(m, "b2", "i2", "k2", "remove_requested");
    m.home.local.intents.b1 = { botId: "b1", inboxId: "i1", keyId: "k1", phase: "committed", deletionProof: false }; return m;
  },
  /** createInbox answer lost: inbox exists at Flux under op-b1, home has a provisioning binding with no inbox id (D1 reversed). */
  provisioningUnknown: cfg => {
    const m = baseModel(DOMAIN_ONE, cfg); addBot(m, "b1", "inb:op-b1", "k1", "provisioning");
    m.home.local.bindings.b1.gen = { inboxId: null, opId: "op-b1", emailKeyRef: "k1", serial: 1 }; m.home.local.bindings.b1.address = null;
    m.env.flux.inboxes["inb:op-b1"].createdUnderOp = "op-b1"; return m;
  },
  /** the A1 shape: a kept inbox with a durable guard while an older DELETE is still held at Flux. */
  keptWithLateDelete: cfg => {
    const m = baseModel(DOMAIN_ONE, cfg); addBot(m, "b1", "i1", "k1");
    const g = m.home.local.bindings.b1.gen;
    m.env.ghost.usedKeepOps.push("keep1"); // the guard comes from a real Keep claim
    m.home.local.keepGuards.i1 = { inboxId: "i1", botId: "b1", gen: g, keepOp: "keep1", keptAtMs: m.env.nowMs, pollUntilMs: m.env.nowMs + 24 * 3600_000, unresolved: ["at1"], lastCheckedAtMs: null };
    heldDelete(m, "i1"); return m;
  },
  twoAddressForeign: cfg => {
    const m = baseModel(DOMAIN_TWO, cfg ?? { listing: "per_account" }); addBot(m, "b1", "i1", "k1"); addBot(m, "b2", "i2", "k2");
    m.env.flux.inboxes.x1 = { inboxId: "x1", installOwned: false, createdUnderOp: "op-other", forBot: "other", address: "addr:x1", state: "active", closingCause: null, closingSinceMs: null, closingSinceStep: null };
    m.env.flux.keys.kx = { keyId: "kx", installOwned: false, mintedUnderOp: "op-other", forBot: "other", state: "live" }; return m;
  },
  /** r3.4d J2 coverage: a verified local backup already exists, so the restore job (arm, capture, swap, prepare, clear) is reachable within depth 4-5 (a backup first costs one extra step). */
  restoreReady: cfg => {
    const m = SEEDS.fresh(cfg);
    m.env.archives.push({ archiveId: "a1", kind: "desktop_backup", topLevelNames: ["messages.db"] }); m.env.ext.archiveDbs.a1 = structuredClone(m.home.local); m.env.ext.nextArchive = 2;
    m.home.fs = { ...m.home.fs, localArchives: ["a1", "a1" + NO_LIVE_SUFFIX] }; return m;
  },
  /** Keep in flight after a REFUSED first RESTORE: reached from fresh() by owner.viewSurface (issues the bot-row token tk), owner.keep (live, citing tk) then flux.apply r1 (the answer r1=refused/active is still to be delivered). Replay-checked in s23.test.ts; it reaches answer.kget.success in 3 more moves (net.answer refused, flux.apply r2, net.answer ok). */
  keepRetryAfterRefused: cfg => {
    const m = SEEDS.fresh(cfg), L = m.home.local, e = m.env, op = "kp:1.1000000.3", au = "au:1.1000000.2", g = L.bindings.b1.gen;
    const tk = ["t", "b", 1, 0, e.nowMs, 1, "b1", g?.serial ?? 1, "inbox:i1"].join("|"); // the reducer's id format (restore-reducer.ts mintToken): the token the owner view issued on the bot row
    e.ghost.tokens.push({ tokenId: tk, kind: "b", botId: "b1", gen: g, park: null, shown: { target: "inbox:i1", address: "addr:i1", inboxId: "i1", keyIds: ["k1"] }, issuedTo: "owner_desktop", issuedAtStep: 1, issuedAtMs: e.nowMs, processId: 1, epoch: 0 });
    L.keepOps[op] = { keepOp: op, botId: "b1", target: "inbox:i1", inboxId: "i1", mode: "live", authorityId: au, claimedAtStep: 0 };
    (L as unknown as { x: unknown }).x = { seq: 1, tok: 3, epoch: 0, blind: false, waits: { r1: { k: "krest", keepOp: op, inboxId: "i1", at: e.nowMs } }, kst: { [op]: "restore" } };
    m.home.surface = [{ section: "bot", target: "inbox:i1", botId: "b1", inboxId: "i1", keyIds: ["k1"], provisionOpId: null, address: "addr:i1", visible: true, line: "Email for this bot", actions: [{ kind: "keep", tokenId: null, enabled: true }, { kind: "remove", tokenId: tk, enabled: true }] }];
    e.step = 4; e.ext.nextReq = 2; e.ext.views = 1;
    e.ghost.authorities.push({ authorityId: au, kind: "keep", principal: "owner_desktop", tokenId: tk, verifiedAtStep: 2, verifiedAtMs: e.nowMs, verifiedInProcess: 1, epoch: 0, botId: "b1", scope: { target: "inbox:i1", inboxId: "i1", keyIds: ["k1"] }, genAtVerify: g, parkAtVerify: null });
    e.ghost.keeps.push({ keepOp: op, botId: "b1", target: "inbox:i1", inboxId: "i1", mode: "live", authorityId: au, claimedAtStep: 2, succeededAtStep: null, succeededAtMs: null, confirmedBy: null });
    e.ghost.usedKeepOps.push(op);
    e.flux.requests.push({ kind: "RESTORE_INBOX", purpose: "keep", target: "i1", credential: "owner", removalId: null, attemptId: null, authorityId: null, keepOp: op, requestId: "r1", copyOf: null, sentAtStep: 3, sentAtMs: e.nowMs, sentInProcess: 1, sentInEpoch: 0, flux: "applied", appliedAtMs: e.nowMs, answer: "pending", answerSeen: null });
    e.ext.results.r1 = { answer: "refused", code: "409_not_closing", fluxStateSeen: "active" };
    // MAIN RULING: /fixture/jobs/_small/RULING-RESTORE-S1.md: this seed starts after r1 committed.
    e.flux.restoreOutcomes = { r1: { requestId: "r1", target: "i1", committedAtStep: e.step, ...e.ext.results.r1 } };
    e.ext.reqMeta.r1 = { botHint: null, deleteReason: "owner" };
    return m;
  },
  /** home is down (just crashed). */
  downAfterCrash: cfg => { const m = SEEDS.fresh(cfg); m.home.proc.phase = "down"; return m; },
};
export const SEED_DOMAIN: Record<string, Domain> = {
  fresh: DOMAIN_ONE, midFlightRemoval: DOMAIN_ONE, legacy1018: DOMAIN_TWO, provisioningUnknown: DOMAIN_ONE, keptWithLateDelete: DOMAIN_ONE,
  twoAddressForeign: DOMAIN_TWO, downAfterCrash: DOMAIN_ONE, restoreReady: DOMAIN_ONE, keepRetryAfterRefused: DOMAIN_ONE,
};

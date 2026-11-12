// CLOUD-EMAIL-KEYSTORE-1019 executable spec: FINITE DOMAINS (review finding 12).
// Pure data, no I/O.
//
// WHY THESE BOUNDS COVER THE BEHAVIOUR (an argument, not a proof; the checker reports these bounds with every run)
//  homes = 2          Every cross-home rule (I6, I6b, I6c, I6d, I10 "usedByOtherHome") quantifies over "another live home".
//                     Homes are symmetric and the rules are existential in the other home, so one other home exhibits every
//                     interaction class (restore twin, take, key war). A third home adds an identical second "other".
//  botsPerHome = 2    Per-bot logic is independent except for what a home shares across bots: one disk snapshot (a save for
//                     bot A can clobber bot B's slot), one proof/evidence, one fence flag, one saver. One bot cannot show
//                     cross-bot clobber; a third bot is symmetric to the second. The default CI domain uses 1 bot for depth and
//                     the nightly domain uses 2.
//  keysPerBot = 4     A bot's key history in one protocol run is: original K1, rotate successor K2, re-rotate K3 after DELETE of
//                     K2, and one stray/leaked key K4. Calls are budgeted (budgets.calls), so no path allocates more than the
//                     pool; an exhausted pool makes Flux answer 500-unapplied, so the bound never deadlocks the model.
//  idemPerBot         Idempotency keys are minted by the reducer from a durable counter; the domain caps sends per bot at
//                     budgets.calls, which bounds the counter.
//  maxOutstanding = 2 per (home, bot, kind): the hazards are "a stale request and the current one" (delayed, duplicated, reordered
//                     answers, a delayed 201 landing after a retry). Two live copies are the minimal witness for every such
//                     interleaving; a third is a second stale copy and is equivalent to the first stale one.
//  dups = 1 per request, lost/crash/fault budgets small: the checker is exhaustive WITHIN these budgets; every fault has a
//                     budget >= 1 so every fault class and every pair of fault classes is reachable inside CI depth.
//  clock              Time matters only through ordering against boundaries (Flux deadline, local stored deadline, margin,
//                     replay-hold expiry). Between two adjacent boundaries behaviour is uniform, so one point per region plus
//                     the boundary points themselves (deadline-2h, deadline-margin, deadline, deadline+1, hold-until,
//                     hold-until+1, local deadline and +1) covers every region. Jumps are explicit events; the state hash uses
//                     time RELATIVE to now (clamped), so equivalent clocks merge.
//  depth              Bounded. CI and nightly depths in the invariants header are bounded checks, not completeness claims; the
//                     coverage report (reachable states, events never fired, branches never taken) is the evidence of what the
//                     bound actually reached.
export const H = 3_600_000;
export const DAY = 24 * H;
export const MARGIN = 10 * 60_000;

export interface Budgets {
  calls: number; // total Flux calls a home may send in one run
  dups: number; // duplicate deliveries (responses and acks)
  lost: number; // lost requests, responses and acks
  crashes: number;
  clock: number; // clock jumps
  owner: number; // owner presses
  fence: number; // fencing flips
  ownerDeletes: number; // owner deletes a key at Flux outside Murage
  fluxFaults: number; // 500 / 503 / 400 outcomes
  flag: number; // flag-off flips
  uses: number; // bot email sends (`use`): 200, or 401 when the key is not honoured; sets lastUsedAt
}
export interface FaultToggles {
  crashChild: boolean; crashSupervisor: boolean; crashPower: boolean;
  lose: boolean; dup: boolean; reorder: boolean;
  flux500: boolean; flux503: boolean; flux400: boolean; flagOff: boolean;
  ownerDelete: boolean; use: boolean; fence: boolean; timeout: boolean;
}
export interface Domain {
  name: string;
  homes: number;
  botsPerHome: number;
  keysPerBot: number;
  maxOutstanding: number; // per (home, bot, kind)
  budgets: Budgets;
  faults: FaultToggles;
  depth: number;
  maxStates: number;
  /** Flux #276: no 503 rotation_incomplete, an UNBOUNDED reaper lag (an expired old key may keep answering 200 at any later time) */
  fluxProfile?: "legacy" | "flux276";
}
const ALL_FAULTS: FaultToggles = {
  crashChild: true, crashSupervisor: true, crashPower: true, lose: true, dup: true, reorder: true,
  flux500: true, flux503: true, flux400: true, flagOff: true, ownerDelete: true, use: true, fence: true, timeout: true,
};
export const CI_DOMAIN: Domain = {
  name: "ci", homes: 1, botsPerHome: 1, keysPerBot: 4, maxOutstanding: 2,
  budgets: { calls: 4, dups: 1, lost: 2, crashes: 2, clock: 3, owner: 2, fence: 1, ownerDeletes: 1, fluxFaults: 2, flag: 1, uses: 1 },
  faults: ALL_FAULTS, depth: 14, maxStates: 400_000,
};
export const CI_DOMAIN_276: Domain = { ...CI_DOMAIN, name: "ci-276", fluxProfile: "flux276", faults: { ...ALL_FAULTS, flux503: false } };
export const NIGHTLY_TWO_HOME: Domain = {
  ...CI_DOMAIN, name: "nightly-two-home", homes: 2, botsPerHome: 1, depth: 22, maxStates: 5_000_000,
  budgets: { ...CI_DOMAIN.budgets, calls: 5, crashes: 2 },
};
export const NIGHTLY_TWO_BOT: Domain = { ...CI_DOMAIN, name: "nightly-two-bot", botsPerHome: 2, depth: 18, maxStates: 5_000_000 };
/** Tiny domain for unit tests of the harness itself. */
export const TINY_DOMAIN: Domain = {
  ...CI_DOMAIN, name: "tiny", depth: 9, maxStates: 60_000,
  budgets: { calls: 3, dups: 1, lost: 1, crashes: 1, clock: 2, owner: 1, fence: 0, ownerDeletes: 1, fluxFaults: 1, flag: 0, uses: 1 },
};
export const homeIds = (d: Domain) => ["h1", "h2", "h3"].slice(0, d.homes);
export const botIds = (d: Domain) => ["b1", "b2", "b3"].slice(0, d.botsPerHome);
export const describeBounds = (d: Domain) =>
  `${d.name}: homes=${d.homes} botsPerHome=${d.botsPerHome} keysPerBot=${d.keysPerBot} maxOutstanding=${d.maxOutstanding} depth=${d.depth} maxStates=${d.maxStates} budgets=${JSON.stringify(d.budgets)}`;

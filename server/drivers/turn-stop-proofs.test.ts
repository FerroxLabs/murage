// Producer: trainred-stopwrite (TurnStopProofs, the Claude driver's proof
// cache); consumer: ProjectTurnLeases.releaseStopHeld via turnChildTracked.
// arev-trainred-stopwrite-n2 H2: a turn whose proof was refused for room is
// missing evidence, never a positive "no child": its folder must stay held.
import { expect, it } from "vitest";
import { TURN_STOP_PROOF_LIMIT, TurnStopProofs, type TurnStopProof } from "./turn-stop-proofs.ts";

const proof = (threadId: string, pending: boolean, child = true): TurnStopProof => ({ threadId, pending, child, closed: new Promise<void>(() => {}) });
/** A settled proof whose child's close is confirmed, the only way a producer can say so. */
const closedProof = (threadId: string): TurnStopProof => ({ threadId, pending: false, child: true, closed: Promise.resolve() });
/** The cache reads `closed` on a later microtask. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

it("a turn refused for room while every proof is pending stays tracked as a child, for its thread only", () => {
  const proofs = new TurnStopProofs<TurnStopProof>();
  for (let index = 0; index < TURN_STOP_PROOF_LIMIT; index++) {
    expect(proofs.admit("thread", `pending-${index}`)).toBe(true);
    proofs.set(`pending-${index}`, proof("thread", true));
  }
  expect(proofs.admit("thread", "refused")).toBe(false);
  expect(proofs.has("refused")).toBe(false);
  expect(proofs.childTracked("thread", "refused")).toBe(true);
  expect(proofs.childTracked("other", "refused")).toBe(false);
  // Nothing of this turn reached the cache at all: positively no child.
  expect(proofs.childTracked("thread", "never-stopped")).toBe(false);
});

it("room is made from the oldest settled proof, and a proof set later replaces the unknown", () => {
  const proofs = new TurnStopProofs<TurnStopProof>(2);
  proofs.set("settled", proof("thread", false));
  proofs.set("pending", proof("thread", true));
  expect(proofs.admit("thread", "next")).toBe(true);
  expect(proofs.has("settled")).toBe(false);
  expect(proofs.has("pending")).toBe(true);
  // The evicted proof watched a child: its turn is unknown now, never "no child".
  expect(proofs.childTracked("thread", "settled")).toBe(true);
  expect(proofs.childTracked("other", "settled")).toBe(false);
  proofs.set("next", proof("thread", true, false));
  expect(proofs.admit("thread", "late")).toBe(false);
  expect(proofs.childTracked("thread", "late")).toBe(true);
  // A setup Stop's proof names no child; a refused turn later proven childless says so.
  expect(proofs.childTracked("thread", "next")).toBe(false);
  proofs.get("pending")!.pending = false;
  proofs.get("next")!.pending = false;
  expect(proofs.admit("thread", "late")).toBe(true);
  expect(proofs.childTracked("thread", "pending")).toBe(true);
  proofs.set("late", proof("thread", false, false));
  expect(proofs.childTracked("thread", "late")).toBe(false);
  // A settled setup proof (no child) evicted for room leaves no unknown behind,
  // but this cache (limit 2) already forgot the unknown "settled" to remember
  // "pending": from then on absence proves nothing, so "next" is held (MAIN
  // 13:44Z: an evicted proof is never permission to write).
  expect(proofs.admit("thread", "after")).toBe(true);
  expect(proofs.has("next")).toBe(false);
  expect(proofs.childTracked("thread", "next")).toBe(true);
});

// arev-trainred-stopwrite-n4 H1: the unknown memory is bounded as well, and
// forgetting an unknown for room is missing evidence, never permission to write.
it("an unknown forgotten for room stays held, and from then on no turn without a proof reads as childless", () => {
  const proofs = new TurnStopProofs<TurnStopProof>(2);
  proofs.set("pending-a", proof("thread", true));
  proofs.set("pending-b", proof("thread", true));
  expect(proofs.childTracked("thread", "never-stopped")).toBe(false);
  for (const turnId of ["refused-0", "refused-1", "refused-2"]) expect(proofs.admit("thread", turnId)).toBe(false);
  expect(proofs.childTracked("thread", "refused-0")).toBe(true);
  expect(proofs.childTracked("thread", "refused-2")).toBe(true);
  expect(proofs.childTracked("thread", "never-stopped")).toBe(true);
  // Positive evidence still answers for the turns it names.
  proofs.set("setup", proof("thread", false, false));
  expect(proofs.childTracked("thread", "setup")).toBe(false);
});

it("a settled proof whose child close was confirmed leaves no unknown when it makes room", async () => {
  const proofs = new TurnStopProofs<TurnStopProof>(2);
  for (let index = 0; index < 4; index++) {
    expect(proofs.admit("thread", `closed-${index}`)).toBe(true);
    proofs.set(`closed-${index}`, closedProof("thread"));
    await settle();
  }
  expect(proofs.has("closed-0")).toBe(false);
  // The child closed: that is positive evidence, so routine eviction does not
  // fill the unknown memory (nor force every later turn to read as unknown).
  expect(proofs.childTracked("thread", "closed-0")).toBe(false);
  expect(proofs.childTracked("thread", "never-stopped")).toBe(false);
  expect(proofs.childTracked("thread", "closed-1")).toBe(false);
  const add = async (turnId: string, value: TurnStopProof) => {
    expect(proofs.admit("thread", turnId)).toBe(true);
    proofs.set(turnId, value);
    await settle();
  };
  // A settled setup proof (no child) evicted for room leaves no unknown either.
  await add("setup", proof("thread", false, false));
  await add("after-setup", closedProof("thread"));
  await add("after-setup-2", closedProof("thread"));
  expect(proofs.has("setup")).toBe(false);
  expect(proofs.childTracked("thread", "setup")).toBe(false);
  // A settled proof whose close was not confirmed is still unknown once evicted.
  await add("unconfirmed", proof("thread", false));
  await add("next", closedProof("thread"));
  await add("next-2", closedProof("thread"));
  expect(proofs.has("unconfirmed")).toBe(false);
  expect(proofs.childTracked("thread", "unconfirmed")).toBe(true);
  expect(proofs.childTracked("other", "unconfirmed")).toBe(false);
});

// arev-trainred-stopwrite-n5 Medium: the producer cannot mark a close by hand.
// The cache watches each proof's own `closed`, so a driver that hands over its
// proof has wired the confirmation, and one whose close never came has not.
it("the cache confirms a close from the proof's own closed promise, and only once it resolves", async () => {
  const proofs = new TurnStopProofs<TurnStopProof>(2);
  // A pending proof is never evicted: the one other slot is reused each time.
  proofs.set("held", proof("thread", true));
  let confirm!: () => void;
  const add = (turnId: string, value: TurnStopProof) => {
    expect(proofs.admit("thread", turnId)).toBe(true);
    proofs.set(turnId, value);
  };
  // Settled, its child's close not yet confirmed: evicted now, the turn is unknown.
  add("open", { threadId: "thread", pending: false, child: true, closed: new Promise<void>(resolve => { confirm = resolve; }) });
  add("after-open", closedProof("thread"));
  expect(proofs.childTracked("thread", "open")).toBe(true);
  // The close resolved before the eviction: positive evidence, nothing unknown is left.
  await settle();
  add("resolved-late", { threadId: "thread", pending: false, child: true, closed: new Promise<void>(resolve => { confirm = resolve; }) });
  expect(proofs.childTracked("thread", "after-open")).toBe(false);
  confirm();
  await settle();
  add("rejected", { threadId: "thread", pending: false, child: true, closed: Promise.reject(new Error("fixture close failed")) });
  expect(proofs.childTracked("thread", "resolved-late")).toBe(false);
  // A close that failed confirms nothing.
  await settle();
  add("last", closedProof("thread"));
  expect(proofs.childTracked("thread", "rejected")).toBe(true);
  expect(proofs.childTracked("other", "rejected")).toBe(false);
});

import { acpVariantOption } from "./config-options.ts";

/** What Murage knows about the effort level of one engine session (ACP-EFFORT-1018 r9 4.1).
 *  clean: Murage never sent an effort to it. pending: a set may have left. set: a set was confirmed. */
export type EffortTouch = "clean" | "pending" | "set";
export interface EffortTouchStore { get(sessionId: string): EffortTouch | undefined; set(sessionId: string, state: EffortTouch): boolean }
export interface EffortBound { sessionId: string; configId: string; value: string }
export type EffortMiss = "notOffered" | "unconfirmed" | "setFailed" | "unsaved" | "lateChange";
export type EffortChoice = { kind: "decides" } | { kind: "explicit"; value: string };

export interface SessionEffortInput {
  choice: EffortChoice;
  sessionId(): string;
  openedNew(): boolean;
  option(): ReturnType<typeof acpVariantOption>;
  set(configId: string, value: string): Promise<unknown>;
  openFresh(): Promise<void>;
  touch: EffortTouchStore;
  halted(): boolean;
  record(fields: Record<string, unknown>): void;
}

/** Thrown when the turn was stopped. The caller settles it as a Stop, never as an effort fallback. */
export const EFFORT_HALT = Object.freeze({ halted: true as const });

/** The turn rule: a prompt goes only to a session whose effort Murage knows. Explicit levels are confirmed by the set's own
 *  answer; "Engine decides" sends nothing, and a session Murage ever touched is replaced once by a fresh one. */
export async function applySessionEffort(i: SessionEffortInput): Promise<
  { outcome: "clean" } | { outcome: "set"; bound: EffortBound } | { outcome: "fallback"; miss: EffortMiss; wanted: string }> {
  let effortSent = false;
  let freshUsed = false;
  const fresh = async () => {
    if (freshUsed) throw new Error("one fresh per turn");
    freshUsed = true;
    if (i.halted()) throw EFFORT_HALT;
    await i.openFresh();
    i.touch.set(i.sessionId(), "clean");
  };
  // A0: a session opened this turn has had nothing sent. It overwrites any older key for a reused native id (L5).
  if (i.openedNew()) i.touch.set(i.sessionId(), "clean");
  const touch = () => i.touch.get(i.sessionId()) ?? "pending";
  if (i.choice.kind === "decides") {
    if (touch() === "clean") { i.record({ outcome: "clean" }); return { outcome: "clean" }; }
    await fresh();
    i.record({ outcome: "clean", fresh: true });
    return { outcome: "clean" };
  }
  const wanted = i.choice.value;
  const attempt = async (): Promise<{ bound: EffortBound } | { miss: EffortMiss }> => {
    const o = i.option();
    if (!o || !o.options.some(entry => entry.id === wanted)) return { miss: "notOffered" };
    if (i.halted()) throw EFFORT_HALT;
    const id = i.sessionId();
    // an explicit level on a session already showing it, with a confirmed key, needs no new request
    if (i.touch.get(id) === "set" && o.currentValue === wanted) return { bound: { sessionId: id, configId: o.configId, value: wanted } };
    if (!i.touch.set(id, "pending")) return { miss: "unsaved" };
    effortSent = true;
    let answer: unknown;
    try { answer = await i.set(o.configId, wanted); } catch { if (i.halted()) throw EFFORT_HALT; return { miss: "setFailed" }; }
    if (i.halted()) throw EFFORT_HALT;
    const got = acpVariantOption(answer);
    if (got?.configId !== o.configId || got.currentValue !== wanted) return { miss: "unconfirmed" };
    i.touch.set(id, "set");
    return { bound: { sessionId: id, configId: o.configId, value: wanted } };
  };
  const r = await attempt();
  if ("bound" in r) { i.record({ outcome: "set" }); return { outcome: "set", bound: r.bound }; }
  // A session opened this turn that was sent no effort IS the fresh session; a resumed one never is.
  const already = i.openedNew() && !effortSent;
  if (!already) await fresh();
  i.record({ outcome: "fallback", miss: r.miss, fresh: true });
  return { outcome: "fallback", miss: r.miss, wanted };
}

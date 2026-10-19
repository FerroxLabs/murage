// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Rules 67 and 68c: one refusal state per turn, on every engine.
//
// A turn that is refused stays refused. `refuse` is one-way (there is no reset, and a second call keeps the first cause), every
// allow a driver hands an engine goes through `allow(...)` (or `verdict(...)` for an owner's answer), and a late hook proof goes
// through `acceptProof()`, which refuses it once the turn is refused. The Codex driver holds one per turn, created before
// `turn/start`; the Claude, Pi and ACP drivers carry their own refusals through the same class.

/** The owner line of a Codex turn refused for a missing SessionStart proof (Rule 68c, AMEND-13 r2). */
export function hookDidNotStartLine(engine: string, startedFirst: boolean): string {
  return `${engine}'s pre-execution hook did not start, so this turn was stopped ${startedFirst ? "as soon as it started" : "before it ran anything"}.`;
}

/** The SessionStart proof of one engine process, kept with the process between turns. A turn on a kept process starts proven
 *  only while the proof is valid and the hook configuration is unchanged; a Rule 67 incident voids it, so the next turn runs the
 *  Rule 68 handshake again on a new process. */
export class HookProof {
  #state: "unproven" | "proven" | "void" = "unproven";
  readonly hookConfig: string;
  constructor(hookConfig: string) { this.hookConfig = hookConfig; }
  get valid(): boolean { return this.#state === "proven"; }
  get voided(): boolean { return this.#state === "void"; }
  sameHookConfig(config: string): boolean { return this.hookConfig === config; }
  void(): void { this.#state = "void"; }
  /** Reached through `TurnRefusal.acceptProof` only. A void proof stays void. */
  confirm(): void { if (this.#state === "unproven") this.#state = "proven"; }
}

type Cause = string | ((startedFirst: boolean) => string);

export class TurnRefusal {
  #cause: string | undefined;
  #started = false;
  #startedFirst = false;
  #hookLive = false;
  readonly #proof: HookProof | undefined;

  /** `proof` is the process's own; with `hookConfig`, a valid proof under the same configuration makes the turn start proven. */
  constructor(opts: { proof?: HookProof; hookConfig?: string } = {}) {
    this.#proof = opts.proof;
    if (opts.proof && opts.hookConfig !== undefined && opts.proof.valid && opts.proof.sameHookConfig(opts.hookConfig)) this.acceptProof();
  }

  /** One-way. Returns true when this call refused the turn; a turn already refused keeps its first cause. */
  refuse(cause: Cause): boolean {
    if (this.#cause !== undefined) return false;
    this.#startedFirst = this.#started;
    this.#cause = typeof cause === "function" ? cause(this.#startedFirst) : cause;
    return true;
  }

  get refused(): boolean { return this.#cause !== undefined; }
  get cause(): string | undefined { return this.#cause; }
  /** Whether the engine had started an item before the refusal. */
  get startedFirst(): boolean { return this.#startedFirst; }
  /** The engine reported an item started on this turn. */
  noteStarted(): void { this.#started = true; }

  /** The hook's SessionStart proof is in hand for this turn. */
  get hookLive(): boolean { return this.#hookLive; }
  /** A SessionStart proof arrived. After a refusal it is not taken: the turn stays refused and stays unproven. */
  acceptProof(): boolean {
    if (this.refused) return false;
    this.#hookLive = true;
    this.#proof?.confirm();
    return true;
  }

  /** Every allow handed to an engine goes through here: once the turn is refused it becomes a deny carrying the cause. */
  allow<T extends { decision: "allow" }>(answer: T): T | { decision: "deny"; reason: string };
  allow<T extends { behavior: "allow" }>(answer: T): T | { behavior: "deny"; message: string };
  allow<T, D>(answer: T, denied: (cause: string) => D): T | D;
  allow(answer: any, denied?: (cause: string) => unknown): unknown {
    if (!this.refused) return answer;
    const cause = this.#cause!;
    if (denied) return denied(cause);
    if (answer && typeof answer === "object" && "behavior" in answer) return { behavior: "deny", message: cause };
    return { decision: "deny", reason: cause };
  }

  /** An owner's answer to a card: an allow arriving after the refusal is a deny. */
  verdict<B extends string>(behavior: B): B | "deny" {
    return this.refused && behavior === "allow" ? "deny" : behavior;
  }
}

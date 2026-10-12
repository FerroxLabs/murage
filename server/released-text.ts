// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two kinds of words that move through a hand-off, kept apart by their types.
//
//   WorkerText    what a worker bot (or its provider) wrote: a reply, a tool name, a tool's arguments, a failure's detail. It is opaque: it
//                 cannot be read as a string, joined, sliced, or put in a template. The only way it gets out is through the one result gate
//                 (server/result-egress.ts), which hands back a ReleasedText or a withheld line.
//   ReleasedText  worker words the gate has checked for this reader now. Only the gate can make one: the constructor checks a key that never leaves
//                 this module, and the one function that holds it is handed out once (`ReleasedText.claim`), to the gate. A constructor reached by
//                 a cast throws and registers nothing. It carries the original it was released from, so a copy cannot be written without its link.
//
// Murage's own words are a third kind (server/murage-status.ts). A bot-facing sink accepts only ReleasedText or a Murage status, so a worker's
// string cannot reach a bot by any other route, whatever expression it is dressed in. The brand is an ES private field, so a cast cannot fake it
// and a structural look-alike does not satisfy the type.

import { failureCodeFrom, type FailureCode } from "./failure-code.ts";

export class EgressViolation extends Error {
  constructor(message: string) { super(message); this.name = "EgressViolation"; }
}

export interface EgressOrigin { threadId: string; messageIds: string[] }

const SEALED = "Worker words cannot be read as text. They leave only through the result gate (server/result-egress.ts).";

let unsealClaimed = false;

export class WorkerText {
  readonly #text: string;
  constructor(text: string) { this.#text = text; Object.freeze(this); }
  /** True for a real WorkerText (the private field is present; a cast or a look-alike object is not). */
  static is(value: unknown): value is WorkerText { return typeof value === "object" && value !== null && #text in value; }
  /** The one way to read worker words back as a string: a function handed out once, to the result gate. A second claim is a violation. */
  static claimUnseal(): (worker: WorkerText) => string {
    if (unsealClaimed) throw new EgressViolation("Worker words can be unsealed only by the result gate");
    unsealClaimed = true;
    return worker => { if (!WorkerText.is(worker)) throw new EgressViolation("Not worker text"); return worker.#text; };
  }
  /** What kind of failure these words describe, as one of the few codes a bot may be told. The words go no further. */
  failureCode(): FailureCode { return failureCodeFrom(this.#text); }
  /** Whether there are any words at all (no word of them is shown). */
  get present(): boolean { return this.#text.trim() !== ""; }
  toString(): never { throw new EgressViolation(SEALED); }
  toJSON(): never { throw new EgressViolation(SEALED); }
  [Symbol.toPrimitive](): never { throw new EgressViolation(SEALED); }
}

export type ReleaseMint = (text: string, copyOf?: EgressOrigin) => ReleasedText;

let mintClaimed = false;
/** Never exported: the constructor refuses a call that does not carry it, so `new (ReleasedText as any)(...)` makes nothing. */
const MINT_KEY = Symbol("released-text-mint");
const releasedTexts = new WeakSet<object>();

export class ReleasedText {
  readonly #text: string;
  /** The original(s) this text was released from; absent for text that stands on no stored message. */
  readonly copyOf: Readonly<EgressOrigin> | undefined;
  private constructor(text: string, copyOf: EgressOrigin | undefined, key: symbol) {
    if (key !== MINT_KEY) throw new EgressViolation("Released text can be made only by the result gate");
    this.#text = text;
    this.copyOf = copyOf ? Object.freeze({ threadId: copyOf.threadId, messageIds: Object.freeze([...copyOf.messageIds]) as unknown as string[] }) : undefined;
    releasedTexts.add(this);
    Object.freeze(this);
  }
  /** Taken once, by the result gate when its module loads. A second claim is a violation, so no other module can mint released text. */
  static claim(): ReleaseMint {
    if (mintClaimed) throw new EgressViolation("Released text can be made only by the result gate");
    mintClaimed = true;
    return (text, copyOf) => new ReleasedText(text, copyOf, MINT_KEY);
  }
  static is(value: unknown): value is ReleasedText { return typeof value === "object" && value !== null && #text in value && releasedTexts.has(value); }
  /** The checked words, for a sink to write. */
  static words(released: ReleasedText): string {
    if (!ReleasedText.is(released)) throw new EgressViolation("Not released text");
    return released.#text;
  }
  toString(): never { throw new EgressViolation("Released text is written by a sink, never joined into a string"); }
  toJSON(): never { throw new EgressViolation("Released text is written by a sink, never joined into a string"); }
  [Symbol.toPrimitive](): never { throw new EgressViolation("Released text is written by a sink, never joined into a string"); }
}

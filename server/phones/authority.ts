// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MessageOrigin } from "../store.ts";

/**
 * The authority for one turn to use the owner's phone. It is held in memory only, never persisted, and is minted from
 * exactly one place in the harness: the idle entry of admitDirectSend, through runIt (S11). Nothing else mints.
 */
export interface PhoneAuthority { threadId: string; turnId: string; generation: string; origin: "desktop" | "companion"; sendId?: string; botId: string; issuedAt: number }

export interface MintFacts {
  origin: MessageOrigin | undefined; unprovenSend: boolean; ownerActs: boolean; answer: boolean;
  automationSource: unknown; handoffRun: unknown; cardContinuation: unknown; askerWake: unknown; commsDepth: number | undefined; unattended: boolean;
  /** Bot task thread, no group, no channel binding, no other member, explicit binding null or OWNER. */
  directThread: boolean;
  offered: boolean;
  /** X2: present only on a failover resend. */
  carry: { held: boolean } | undefined;
}

const absent = (v: unknown): boolean => v === undefined || v === null;

/** True only for a fresh (or authorised-failover) turn the owner started directly. Anything malformed or missing is false. */
export function phoneMintEligible(f: MintFacts): boolean {
  if (typeof f !== "object" || f === null) return false;
  if (f.origin !== "desktop" && f.origin !== "companion") return false;
  if (f.unprovenSend !== false) return false;
  if (f.ownerActs !== true) return false;
  if (f.answer !== false) return false;
  if (!absent(f.automationSource) || !absent(f.handoffRun) || !absent(f.cardContinuation) || !absent(f.askerWake)) return false;
  if (f.commsDepth !== undefined && f.commsDepth !== 0) return false;
  if (f.unattended !== false) return false;
  if (f.directThread !== true) return false;
  if (f.offered !== true) return false;
  if (f.carry !== undefined && (typeof f.carry !== "object" || f.carry === null || f.carry.held !== true)) return false;
  return true;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export class PhoneAuthorities {
  readonly #byGeneration = new Map<string, Readonly<PhoneAuthority>>();
  readonly #generationByThread = new Map<string, string>();

  /** Records a new authority. Throws on a malformed grant or a reused generation; a newer grant on a thread ends the older one. */
  mint(a: Omit<PhoneAuthority, "issuedAt">): PhoneAuthority {
    if (typeof a !== "object" || a === null) throw new Error("phone authority: malformed grant");
    if (!nonEmpty(a.threadId) || !nonEmpty(a.turnId) || !nonEmpty(a.generation) || !nonEmpty(a.botId)) throw new Error("phone authority: malformed grant");
    if (a.origin !== "desktop" && a.origin !== "companion") throw new Error("phone authority: origin is not owner-proven");
    if (a.sendId !== undefined && !nonEmpty(a.sendId)) throw new Error("phone authority: malformed grant");
    if (this.#byGeneration.has(a.generation)) throw new Error("phone authority: generation already used");
    const earlier = this.#generationByThread.get(a.threadId);
    if (earlier !== undefined) this.#byGeneration.delete(earlier);
    const minted: Readonly<PhoneAuthority> = Object.freeze({
      threadId: a.threadId, turnId: a.turnId, generation: a.generation, origin: a.origin, botId: a.botId, issuedAt: Date.now(),
      ...(a.sendId !== undefined ? { sendId: a.sendId } : {}),
    });
    this.#byGeneration.set(minted.generation, minted);
    this.#generationByThread.set(minted.threadId, minted.generation);
    return minted;
  }

  live(generation: string): PhoneAuthority | null {
    if (!nonEmpty(generation)) return null;
    return this.#byGeneration.get(generation) ?? null;
  }

  heldByThread(threadId: string): PhoneAuthority | null {
    if (!nonEmpty(threadId)) return null;
    const generation = this.#generationByThread.get(threadId);
    return generation === undefined ? null : this.#byGeneration.get(generation) ?? null;
  }

  revokeGeneration(generation: string): void {
    const a = this.#byGeneration.get(generation);
    if (a === undefined) return;
    this.#byGeneration.delete(generation);
    if (this.#generationByThread.get(a.threadId) === generation) this.#generationByThread.delete(a.threadId);
  }

  revokeThread(threadId: string): void {
    const generation = this.#generationByThread.get(threadId);
    if (generation !== undefined) this.revokeGeneration(generation);
  }

  revokeBot(botId: string): void {
    for (const a of [...this.#byGeneration.values()]) if (a.botId === botId) this.revokeGeneration(a.generation);
  }

  revokeAll(): void {
    this.#byGeneration.clear();
    this.#generationByThread.clear();
  }
}

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PACK_PAGE = 40;
export const PACK_LENT_MAX = 160;

declare const packAuthority: unique symbol;

/** Proof of the owner's input in the authenticated generation. The handoff boundary's private constructor freezes this
 * after checking the claim and input row; request bodies and queued item JSON never supply it. */
export interface PackAuthority {
  readonly [packAuthority]: true;
  readonly fromBotId: string;
  readonly fromThreadId: string;
  readonly generation: string;
  readonly inputMessageId: string;
}

/** Frozen at render and checked again at every provider write. Refs identify exactly the retained source rows. */
export interface PackBinding {
  readonly packId: string;
  readonly destinationThreadId: string;
  readonly generation: string;
  readonly sourceThreadId: string;
  readonly sourceLeafId: string | null;
  readonly refs: ReadonlyArray<{ readonly id: string; readonly mrow: number }>;
  /** The delegated row on the destination branch; null on the job's first turn. */
  readonly anchor: { readonly messageId: string; readonly mrow: number } | null;
  readonly driverKind: string;
  /** Rows released in a thread_read answer during this generation. */
  readonly page?: true;
}

/** Decoded pack metadata. Packs outlive queue cleanup and are removed with either conversation. No source text is stored. */
export interface DelegationPack {
  readonly id: string;
  readonly delegation_id: string;
  readonly source_thread_id: string;
  readonly source_bot_id: string;
  readonly target_bot_id: string;
  /** Null at enqueue; bound once at the first render. */
  readonly destination_thread_id: string | null;
  /** The lent set: at most 160 message IDs, oldest first, from the source branch at cut_at. */
  readonly refs: readonly string[];
  /** Union of ref IDs whose pack guard passed at a write or were released in a page; preparation does not establish delivery. */
  readonly prepared: readonly string[];
  readonly cut_at: number;
  readonly created_at: number;
}

/** SQLite stores the ID arrays as JSON text. Decode and validate them before using a pack. */
export interface DelegationPackRow extends Omit<DelegationPack, "refs" | "prepared"> {
  readonly refs: string;
  readonly prepared: string;
}

/** The pack fields of the direct startTurn options, carried by the logical input's rebuild chain. */
export interface DelegationPackTurnOptions {
  /** Server-owned; never taken from a request body. Suppresses every pack for this input across all rebuilds. */
  packSuppressed?: true;
}

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW r4.1 (MEMW-POSTINGS-OVERSIZE G1-G4): the price of the one-row-operation transactions that drain an oversize text's postings. Every
// drop, fill, list, unlist and completion transaction changes the rows of ONE shape and is priced from SQLite page-format maxima, so no
// measured rate enters it. The reserve of each is the flat MEMW_W_STEP_BYTES (F_W frames), as the other fill / delete steps.
import { MEMW_W_STEP_BYTES } from "./index-wal.ts";

/** SQLite btreeInt.h BTCURSOR_MAX_DEPTH (node:sqlite 3.50.4 reads 20): a write on a deeper tree rolls back with 0 frames, so h <= 20 at the start of every committed op. */
export const MEMW_BTREE_MAX_DEPTH = 20;
/** The write envelope of IndexWal.write: wal_check, verified_through and (once) file_id in index_meta, at most 3 x P_op(7, 1) (G2). */
export const MEMW_ENVELOPE_FRAMES = 324;
/** The usable bytes of one 4,096 B overflow page. */
const OVERFLOW_PAGE = 4_092;
/** Overflow pages of a payload of `p` bytes; at least 1 for every row (charged whatever the threshold, Q1). */
export const ovf = (p: number): number => Math.max(1, Math.ceil(p / OVERFLOW_PAGE));
/** G1: frames one row operation (insert, delete or update of one row) on a tree of height h costs: two balance passes x 5 pages a level, page 1,
 * a freelist trunk and leaf, root deepening (h + 1), the row's chain and one trunk per freed chain page. */
export const pOp = (h: number, payload: number): number => 13 * (h + 1) + 2 * ovf(payload) + 2;
/** F_W: the frames the flat step reserve holds, at the 4,096 B page. */
export const stepFrames = (pageSize: number): number => Math.floor(MEMW_W_STEP_BYTES / (pageSize + 24));
/** Row overhead added to a term's bytes in the postings index payload. */
const ROW = 24;
const H = MEMW_BTREE_MAX_DEPTH;
/** The declared price, in frames, of each transaction shape (G3). `term` = utf8 bytes of the term, `parts` = bytes of the part row's terms. */
export const stepPrice = {
  /** One posting dropped or filled. */
  posting: (term: number): number => pOp(H, term + ROW) + MEMW_ENVELOPE_FRAMES,
  /** List or unlist one posting_todo row. */
  todo: (): number => pOp(H, 1) + MEMW_ENVELOPE_FRAMES,
  /** C1: empty the part (UPDATE terms='[]' frees its chain), priced with the index row SQLite may also rewrite. */
  empty: (partBytes: number): number => pOp(H, partBytes + ROW) + pOp(H, 1) + MEMW_ENVELOPE_FRAMES,
  /** C2: delete the emptied part row and its posting_drop_seq row. */
  complete: (): number => 2 * pOp(H, 1) + MEMW_ENVELOPE_FRAMES,
};
/** Scratch frames of tokenizing a text of `bytes` UTF-8 bytes through posting_words (r4 R6). */
export const scratchFrames = (bytes: number, pageSize: number): number => bytes <= 0 ? 0 : Math.ceil(4 * bytes / pageSize) + 8;

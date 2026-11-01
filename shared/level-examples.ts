// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 3.2: the level menu's example table, as data. Every
// cell is what the code does for a turn with no saved grant and no task
// allowance ("goes-ahead" means no card). The client words the rows
// (`ux.l1.level.*`); the reader lane's level-examples test (L1b, test 6)
// evaluates every cell through autoVerdict, so the table cannot drift.
//
// Sources: rows 1, 3, 4, 6 auto-mode; row 2 own-workspace; row 5 the
// destructive and prompt guards lifted by fullAccessCovers; rows 7 to 9 the
// stop line, lifted only by No limits on a covered owner turn; row 10 the
// peer-contact gate (when "Ask me before contacting other bots" is on); rows
// 11 and 12 the key guard and always-ask, at every level.

export const LEVEL_IDS = ["ask", "auto", "full", "unlimited"] as const;
export type LevelId = (typeof LEVEL_IDS)[number];

export type LevelCell = "asks" | "goes-ahead";

export type OwnerRowId =
  | "read-given"
  | "write-own-folder"
  | "draft-reply"
  | "ordinary-command"
  | "destructive-inside-or-input"
  | "message-known"
  | "someone-new-or-public"
  | "delete-outside"
  | "pay"
  | "contact-bot"
  | "read-keys"
  | "wipe-command";

export interface OwnerExampleRow {
  id: OwnerRowId;
  cells: Readonly<Record<LevelId, LevelCell>>;
  /** row 10 holds only while the bot's "Ask me before contacting other bots" is on */
  when?: "peer-contact-ask-first";
}

const row = (id: OwnerRowId, ask: LevelCell, auto: LevelCell, full: LevelCell, unlimited: LevelCell, when?: OwnerExampleRow["when"]): OwnerExampleRow =>
  ({ id, cells: { ask, auto, full, unlimited }, ...(when ? { when } : {}) });

/** Owner desktop turn, in the order the menu shows them. */
export const OWNER_ROWS: readonly OwnerExampleRow[] = [
  row("read-given", "asks", "goes-ahead", "goes-ahead", "goes-ahead"),
  row("write-own-folder", "goes-ahead", "goes-ahead", "goes-ahead", "goes-ahead"),
  row("draft-reply", "asks", "goes-ahead", "goes-ahead", "goes-ahead"),
  row("ordinary-command", "asks", "goes-ahead", "goes-ahead", "goes-ahead"),
  row("destructive-inside-or-input", "asks", "asks", "goes-ahead", "goes-ahead"),
  row("message-known", "asks", "goes-ahead", "goes-ahead", "goes-ahead"),
  row("someone-new-or-public", "asks", "asks", "asks", "goes-ahead"),
  row("delete-outside", "asks", "asks", "asks", "goes-ahead"),
  row("pay", "asks", "asks", "asks", "goes-ahead"),
  row("contact-bot", "asks", "asks", "goes-ahead", "goes-ahead", "peer-contact-ask-first"),
  row("read-keys", "asks", "asks", "asks", "asks"),
  row("wipe-command", "asks", "asks", "asks", "asks"),
];

/** A cell of the other-turns rows:
 *  - "lower-of-ceiling": runs at the lower of the routine's ceiling and this level (asks at Ask, goes ahead above)
 *  - "asks-unless-routine-grant": asks at every level unless allowed for the routine (never for a payment)
 *  - "goes-ahead-with-option": goes ahead only with "Also skip approvals for my messages" on, otherwise asks */
export type OtherCell = "asks" | "lower-of-ceiling" | "asks-unless-routine-grant" | "goes-ahead-with-option";

export type OtherRowId = "routine" | "owner-channel" | "other-channel-or-webhook";

export interface OtherExampleRow {
  id: OtherRowId;
  /** an ordinary action or command */
  ordinary: Readonly<Record<LevelId, OtherCell>>;
  /** someone new, a public post, a delete outside, a payment */
  stopLine: Readonly<Record<LevelId, OtherCell>>;
  /** row notes the client words: a routine's payments are never allowed for it;
   * reads and its own folder still go on an unattended turn */
  notes: readonly ("never-for-payment" | "reads-and-own-folder-go")[];
}

const every = (cell: OtherCell): Record<LevelId, OtherCell> => ({ ask: cell, auto: cell, full: cell, unlimited: cell });

export const OTHER_ROWS: readonly OtherExampleRow[] = [
  { id: "routine", ordinary: every("lower-of-ceiling"), stopLine: every("asks-unless-routine-grant"), notes: ["never-for-payment"] },
  {
    id: "owner-channel",
    ordinary: { ask: "asks", auto: "asks", full: "goes-ahead-with-option", unlimited: "goes-ahead-with-option" },
    stopLine: { ask: "asks", auto: "asks", full: "asks", unlimited: "goes-ahead-with-option" },
    notes: [],
  },
  { id: "other-channel-or-webhook", ordinary: every("asks"), stopLine: every("asks"), notes: ["reads-and-own-folder-go"] },
];

/** 3.2: the whole table the level menu renders, below the four rows. */
export const LEVEL_EXAMPLES = { levels: LEVEL_IDS, owner: OWNER_ROWS, other: OTHER_ROWS } as const;

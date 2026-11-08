// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 1.0.13 shell contract (handoffs/HANDOFF-1013-UX-L2A.md). Every lane that
// renders into the shell (L2B Needs you and Health, L6A first run, L2C This
// month, L6C agency, L7 phone) imports its types from here, so there is one
// definition of each. Types only: nothing in this file runs.
import type { ConnectionToRestore, InboxSegment, InboxView } from "../../../shared/inbox";
import type { HealthIssueLevel } from "../../../shared/health-levels";

/** The views the main column shows. Mirrors AppState["activeView"]. */
export type ShellView = "chat" | "team-map" | "routines" | "skill-recorder" | "all-chats" | "today" | "needs-you" | "health";

/** The Needs you page's tabs: the Inbox's own views ("decisions" is the Needs you umbrella). */
export type NeedsYouTab = InboxView;

/** The four doors in the rail, and the phone's tab bar, in this order. */
export type ShellDoor = "today" | "chats" | "needs-you" | "routines";
export const SHELL_DOORS: readonly ShellDoor[] = ["today", "chats", "needs-you", "routines"];

/** A Today status tag. `tone` picks the dot colour; `onClick` makes the tag a button. */
export type TodayTone = "ok" | "info" | "warn" | "bad" | "neutral";
export interface TodayTag {
  key: string;
  tone: TodayTone;
  text: string;
  onClick?: () => void;
}

/** One Needs you row as Today's card shows it: labelled by the question, never by an option. */
export interface NeedsSummaryRow {
  id: string;
  botId?: string;
  line: string;
  meta: string;
  open: () => void;
  /** Which Needs you list the item is in (approval, question, connection). Set on `rows`; `top` leaves it out. */
  segment?: InboxSegment;
  /** A waiting request (an approval or a question): where its card lives, so Today can read it after first paint
   *  and answer it from the row (NEEDSYOU-INLINE-APPROVE). Set on `rows` only. */
  request?: { threadId: string; messageId: string; version: string };
}

/** The one Needs you count (actionable cards only; snoozed rows still count) and the oldest rows. */
export interface NeedsSummary {
  /** undefined = not known yet */
  count: number | undefined;
  /** the count could not be refreshed and may be out of date */
  stale: boolean;
  /** oldest first, at most three */
  top: NeedsSummaryRow[];
  /** Every owed item the one Inbox read returned (up to 25), oldest first, each with its `segment`, so a caller
   *  filters by segment BEFORE it cuts (Today 1.0.18). Absent until a read answers; `count` stays the truth. */
  rows?: NeedsSummaryRow[];
  /** APPROVALS-SIMPLE-1018 (needs-inline Astra r2 Medium): the owed total of the SAME read as `rows` (the badge's own
   *  formula, decisions plus snoozed owed), so a row answered from Today is taken off a count that matches its rows. */
  rowsCount?: number;
  /** The badge total broken down by segment, from the same read. */
  split?: { approvals: number; questions: number; connections: number };
  /** Connections only failing routines know are dead (`InboxPage.restore`), from the same read. */
  restore?: ConnectionToRestore[];
  /** The strongest open Health level from the owner's Inbox read; absent on any other read. */
  healthLevel?: HealthIssueLevel | null;
}

/**
 * Health (Sean 10-30): its own page off the You menu, with a status dot.
 *   act      the owner must do something; only then Needs you shows a Health row
 *   watch    worth a look, nothing is urgent: amber, never counted
 *   ok       nothing to do, even while Murage is finishing something
 *   unknown  not answered yet: a grey dot, never red
 */
export type HealthLevel = "ok" | "watch" | "act" | "unknown";
export interface HealthStatus {
  level: HealthLevel;
  /** one plain sentence */
  line: string;
}

export interface NeedsYouPageProps {
  tab: NeedsYouTab;
  onTabChange: (tab: NeedsYouTab) => void;
  onOpenChat: (botId: string, threadId?: string) => void;
  /** Leaves the page (back to Today): what Esc and Close do on the overlay shown if the page body fails to load. */
  onLeave?: () => void;
  /** The shell's one Health reading, for the quiet link above the list. */
  health?: HealthStatus;
}

export interface HealthPageProps {
  onOpenNeedsYou: () => void;
  /** Back, the close button and Esc: to the view the person came from, or Today. */
  onLeave: () => void;
}

export interface FirstRunTodayCardProps {
  chiefBotId: string | null;
  /** through the browser door: setup finishes on the computer */
  remote: boolean;
  onContinueSetup: () => void;
}

export interface MonthCardProps {
  onOpenUsage: () => void;
}

export interface ClientsCardProps {
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenUsage: () => void;
}

export interface OtherWorkspacesStripProps {
  onOpenWorkspace: (workspaceId: string, opts: { needsYou: true }) => void;
}

export interface PhoneTabsProps {
  active: ShellDoor;
  needsCount: number | undefined;
  onSelect: (tab: ShellDoor) => void;
}

/** GET /api/engine-health (server/engine-health-routes.ts). */
export type EngineHealthState = "ready" | "checking" | "signed-out" | "limit" | "off" | "missing";
export type FluxHealthState = "ok" | "allowance-used-up" | "key-problem" | "none";
export interface EngineHealthRow {
  id: string;
  label: string;
  state: EngineHealthState;
  line: string;
  /** How many bots run on this engine (absent from an older server: read as 0). */
  usedBy?: number;
  /** The bundled Fuigo: Flux Router speaks for it. */
  fuigo?: true;
}
/** The Flux Router figures from a valid key check only (server/engine-health-routes.ts). */
export interface FluxHealthInfo {
  spendPct: number | null;
  expires: string | null;
}
export interface EngineHealthAnswer {
  engines: EngineHealthRow[];
  primary: EngineHealthRow | null;
  /** The engine chosen as the default (absent from an older server, null when none is set or it is gone). */
  defaultId?: string | null;
  flux: FluxHealthState;
  /** Absent from an older server, null while the key has not been read as valid. */
  fluxInfo?: FluxHealthInfo | null;
  /** The installed Fuigo's version from its install receipt (absent from an older server, null when unknown). */
  fuigoVersion?: string | null;
  checkedAt: number;
}

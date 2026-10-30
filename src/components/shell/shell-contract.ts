// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The 1.0.13 shell contract (handoffs/HANDOFF-1013-UX-L2A.md). Every lane that
// renders into the shell (L2B Needs you and Health, L6A first run, L2C This
// month, L6C agency, L7 phone) imports its types from here, so there is one
// definition of each. Types only: nothing in this file runs.
import type { InboxView } from "../../../shared/inbox";

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
}

/** The one Needs you count (actionable cards only; snoozed rows still count) and the oldest rows. */
export interface NeedsSummary {
  /** undefined = not known yet */
  count: number | undefined;
  /** the count could not be refreshed and may be out of date */
  stale: boolean;
  /** oldest first, at most three */
  top: NeedsSummaryRow[];
}

/**
 * Health (Sean 10-30): its own page off the You menu, with a status dot.
 *   act      the owner must do something; only then Needs you shows a Health row
 *   watch    something is off and Murage is handling it
 *   ok       nothing to do
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
}

export interface HealthPageProps {
  onOpenNeedsYou: () => void;
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
export type EngineHealthState = "ready" | "signed-out" | "limit" | "off" | "missing";
export type FluxHealthState = "ok" | "allowance-used-up" | "key-problem" | "none";
export interface EngineHealthRow {
  id: string;
  label: string;
  state: EngineHealthState;
  line: string;
}
export interface EngineHealthAnswer {
  engines: EngineHealthRow[];
  primary: EngineHealthRow | null;
  flux: FluxHealthState;
  checkedAt: number;
}

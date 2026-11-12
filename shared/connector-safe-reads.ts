// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixed credential checks, never supplied by a model. Keep this table shared
// with Settings so the stated coverage matches the probes we actually send.
// These reads return profile/auth metadata or a bounded calendar list, not messages.
export const CONNECTOR_SAFE_READS: Readonly<Record<string, { tool: string; args: Record<string, string | number | boolean> }>> = {
  gmail: { tool: "GMAIL_GET_PROFILE", args: { user_id: "me" } },
  googlecalendar: { tool: "GOOGLECALENDAR_LIST_CALENDARS", args: { max_results: 1 } },
  slack: { tool: "SLACK_TEST_AUTH", args: {} },
  buffer: { tool: "BUFFER_GET_ACCOUNT_CONTEXT", args: {} },
};
export const CONNECTOR_PROBE_INTERVAL_MS = 60 * 60_000;

/** Best-effort background coverage; hourly budget and polling can defer to dispatch. */
export const PREFLIGHT_LOOKAHEAD_MS = CONNECTOR_PROBE_INTERVAL_MS;

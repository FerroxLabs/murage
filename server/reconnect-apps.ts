// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// ONE ROW PER APP for the owner's reconnect line. The health store keeps one
// incident per lapsed account (its own id, notification and sign-in route), so
// an app with two accounts is two incidents. The line read them as two apps:
// "Freshdesk needs you to sign in again. Freshdesk needs you to sign in again."
// with two identical buttons (1.0.19 owner report). Both list routes answer
// through this: one row per app, every account once, every incident id, and
// the first incident as the one its Reconnect opens.

export interface ReconnectIncidentRow { slug: string; label: string; accounts: ReadonlyArray<{ id: string; alias?: string }>; incidentId: string }
export interface ReconnectAppRow { slug: string; label: string; accounts: Array<{ id: string; alias?: string }>; incidentId: string; incidentIds: string[] }

export function reconnectApps(incidents: ReadonlyArray<ReconnectIncidentRow>): ReconnectAppRow[] {
  const apps = new Map<string, ReconnectAppRow>();
  for (const { slug, label, accounts, incidentId } of incidents) {
    let app = apps.get(slug);
    if (!app) { app = { slug, label, accounts: [], incidentId, incidentIds: [] }; apps.set(slug, app); }
    for (const account of accounts) if (!app.accounts.some(held => held.id === account.id)) app.accounts.push({ ...account });
    if (!app.incidentIds.includes(incidentId)) app.incidentIds.push(incidentId);
  }
  return [...apps.values()];
}

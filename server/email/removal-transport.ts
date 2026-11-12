// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two Flux calls that remove something (DELETE the inbox, revoke a bot key), kept out of FluxEmailClient so the only code that can reach them is
// removal-gate.ts, which checks an authority before every call (restore-park r3.1 section 8). Nothing but removal-gate.ts imports this module.
import type { FluxEmailClient, FluxOutcome } from "./flux-email-client.ts";

export interface RemovalTransport {
  deleteInbox(inboxId: string): Promise<FluxOutcome<Record<string, unknown>>>;
  revokeBotKey(keyId: string): Promise<FluxOutcome<Record<string, unknown>>>;
}

export function createRemovalTransport(client: Pick<FluxEmailClient, "request">): RemovalTransport {
  return {
    deleteInbox: inboxId => client.request<Record<string, unknown>>({ kind: "owner" }, "DELETE", `/v1/email/inboxes/${encodeURIComponent(inboxId)}`),
    revokeBotKey: keyId => client.request<Record<string, unknown>>({ kind: "owner" }, "DELETE", `/api/desktop/bot-keys/${encodeURIComponent(keyId)}`, { host: "app" }),
  };
}

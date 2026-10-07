// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { isWorkspaceOwner, threadHumanPrincipal } from "./human-principals.ts";

export const CONTACT_ROOM_READ_ONLY_REASON = "This is a channel person’s delegated conversation. Start an owner room to send a message.";

export function groupReadOnlyState(threadId: string): { readOnlyReason?: string } {
  return isWorkspaceOwner(threadHumanPrincipal(threadId)) ? {} : { readOnlyReason: CONTACT_ROOM_READ_ONLY_REASON };
}

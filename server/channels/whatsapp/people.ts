// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WhatsApp people (design 5.1, 5.3). The owner is the linked number and nothing else; a contact is always a
// separate person. The server rule that makes this hold lives in linkHumanBinding (HUMAN_OWNER_INELIGIBLE), so even
// a caller that asked for "owner" on a contact binding is refused there.
import { WORKSPACE_OWNER, humanBindingStatus, linkHumanBinding, observeVerifiedHuman, type VerifiedHumanOrigin } from "../../human-principals.ts";
import { ownerMemoryTicket } from "../../memory/authority.ts";
import { canonicalJid } from "./core/lid.ts";
import type { WhatsAppBinding } from "./event.ts";
import type { WhatsAppPeople } from "./service.ts";

/** One binding per (connection, linked number, sender). The authority is always the linked number. */
export function whatsappOrigin(binding: WhatsAppBinding, userId: string): VerifiedHumanOrigin {
  return { platform: "whatsapp", connectionId: binding.connectionId, authorityId: binding.linkedPn, userId };
}

function current(bindingId: string) {
  return humanBindingStatus(ownerMemoryTicket()).bindings.find(item => item.id === bindingId);
}

/** Observes the linked number's own binding and links it to the workspace owner. Idempotent. Returns the binding id. */
export function ensureOwnerLinked(binding: WhatsAppBinding): string {
  const id = observeVerifiedHuman(whatsappOrigin(binding, binding.linkedPn));
  const row = current(id);
  if (!row) throw new Error("HUMAN_BINDING_UNAVAILABLE");
  if (row.personId !== WORKSPACE_OWNER) linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: row.revision, as: "owner" });
  return id;
}

/**
 * The guest principal of an enabled group (design 5.1): a person created by the server when the owner enables the group,
 * never linked to any participant and never the owner (the owner rule in linkHumanBinding refuses it). It owns the
 * group's one thread, so recall and capture see that conversation and nothing of the owner's or of any participant's.
 * Idempotent: the binding id is derived from (connection, linked number, group JID).
 */
export function ensureGroupGuest(binding: WhatsAppBinding, groupJid: string, groupName?: string): string {
  const jid = canonicalJid(groupJid);
  const label = "WhatsApp group: " + (groupName?.trim() || jid.split("@")[0]);
  const id = observeVerifiedHuman(whatsappOrigin(binding, jid), { name: label });
  const row = current(id);
  if (!row) throw new Error("HUMAN_BINDING_UNAVAILABLE");
  if (row.personId === WORKSPACE_OWNER) throw new Error("HUMAN_OWNER_INELIGIBLE");
  if (!row.personId) linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: row.revision, as: "person" });
  return id;
}

export function createWhatsAppPeople(): WhatsAppPeople {
  return {
    linkOwner(binding) { ensureOwnerLinked(binding); },
    async linkContact({ binding, userId, name, personId }) {
      // The linked number is the owner's binding; approving it as a contact would try to demote the owner.
      if (userId === binding.linkedPn || userId === binding.linkedLid || canonicalJid(userId) === canonicalJid(binding.linkedPn)) {
        throw new Error("That number is the linked account.");
      }
      const id = observeVerifiedHuman(whatsappOrigin(binding, userId), name ? { name } : undefined);
      const row = current(id);
      if (!row) throw new Error("HUMAN_BINDING_UNAVAILABLE");
      if (row.personId === WORKSPACE_OWNER) throw new Error("HUMAN_OWNER_INELIGIBLE");
      // An already linked contact keeps its person unless the owner picked a different one.
      if (row.personId && (!personId || personId === row.personId)) return { personId: row.personId };
      const linked = linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: row.revision, as: "person", ...(personId ? { personId } : {}) });
      if (!linked.personId) throw new Error("HUMAN_BINDING_UNAVAILABLE");
      return { personId: linked.personId };
    },
    enableGroup({ binding, groupJid, name }) { ensureGroupGuest(binding, groupJid, name); },
    observe({ binding, userId, name, displayPn }) {
      // The owner typing in a group is already the owner's own binding; a push name must not rewrite it.
      if (userId === binding.linkedPn || userId === binding.linkedLid || canonicalJid(userId) === canonicalJid(binding.linkedPn)) return;
      const display = { ...(name ? { name } : {}), ...(displayPn ? { username: displayPn } : {}) };
      observeVerifiedHuman(whatsappOrigin(binding, userId), Object.keys(display).length ? display : undefined);
    },
  };
}

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WhatsApp owner rule (design 5.1, 5.3, 7.4): the linked number is the only possible owner, and the server enforces it
// inside linkHumanBinding, so a contact can never become the owner whatever the caller asks for.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { WORKSPACE_OWNER, humanBindingStatus, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, revokeHumanConnection } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { createWhatsAppPeople, ensureOwnerLinked, whatsappOrigin } from "./channels/whatsapp/people.ts";
import type { WhatsAppBinding } from "./channels/whatsapp/event.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

const binding: WhatsAppBinding = { connectionId: "conn-1", linkedPn: "15551230000@s.whatsapp.net", linkedLid: "99887766@lid", chiefBotId: "chief" };
const CONTACT = "15557654321@s.whatsapp.net";
const bindingRow = (id: string) => humanBindingStatus(ownerMemoryTicket()).bindings.find(item => item.id === id)!;

it("links the linked number's own binding as the workspace owner, idempotently", () => {
  const id = ensureOwnerLinked(binding);
  expect(resolveHumanBinding(id).personId).toBe(WORKSPACE_OWNER);
  expect(ensureOwnerLinked(binding)).toBe(id);
  expect(bindingRow(id).origin).toEqual({ platform: "whatsapp", connectionId: "conn-1", authorityId: binding.linkedPn, userId: binding.linkedPn });
});

it("refuses owner for any WhatsApp binding whose user is not the linked number", () => {
  const id = observeVerifiedHuman(whatsappOrigin(binding, CONTACT));
  expect(() => linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: "owner" })).toThrow("HUMAN_OWNER_INELIGIBLE");
  expect(() => resolveHumanBinding(id)).toThrow("HUMAN_LINK_REQUIRED");
  // A group is a different user id too.
  const group = observeVerifiedHuman(whatsappOrigin(binding, "120363000000000000@g.us"));
  expect(() => linkHumanBinding(ownerMemoryTicket(), { bindingId: group, expectedRevision: 1, as: "owner" })).toThrow("HUMAN_OWNER_INELIGIBLE");
});

it("keeps the owner rule off other platforms", () => {
  const id = observeVerifiedHuman({ platform: "slack", connectionId: "c", authorityId: "TEAM", userId: "UOWNER" });
  expect(linkHumanBinding(ownerMemoryTicket(), { bindingId: id, expectedRevision: 1, as: "owner" }).personId).toBe(WORKSPACE_OWNER);
});

it("approval links a contact to a separate person and never to the owner", async () => {
  const people = createWhatsAppPeople();
  await people.linkOwner!(binding);
  const first = await people.linkContact({ binding, userId: CONTACT, senderJid: CONTACT, name: "Ana" });
  expect(first.personId).not.toBe(WORKSPACE_OWNER);
  const id = observeVerifiedHuman(whatsappOrigin(binding, CONTACT));
  expect(resolveHumanBinding(id).personId).toBe(first.personId);
  // Approving the same contact again keeps the person; picking another existing person relinks.
  expect((await people.linkContact({ binding, userId: CONTACT, senderJid: CONTACT })).personId).toBe(first.personId);
  const other = await people.linkContact({ binding, userId: "15550001111@s.whatsapp.net", senderJid: "15550001111@s.whatsapp.net" });
  expect((await people.linkContact({ binding, userId: CONTACT, senderJid: CONTACT, personId: other.personId })).personId).toBe(other.personId);
});

it("approval refuses the linked number, its LID, and an owner person id", async () => {
  const people = createWhatsAppPeople();
  await people.linkOwner!(binding);
  await expect(people.linkContact({ binding, userId: binding.linkedPn, senderJid: binding.linkedPn })).rejects.toThrow("linked account");
  await expect(people.linkContact({ binding, userId: binding.linkedLid!, senderJid: binding.linkedLid! })).rejects.toThrow("linked account");
  await expect(people.linkContact({ binding, userId: CONTACT, senderJid: CONTACT, personId: WORKSPACE_OWNER })).rejects.toThrow("HUMAN_PERSON_UNKNOWN");
  expect(resolveHumanBinding(ensureOwnerLinked(binding)).personId).toBe(WORKSPACE_OWNER);
});

it("observing a sender shows it in the People list without linking it", () => {
  createWhatsAppPeople().observe!({ binding, userId: CONTACT, name: "Ana", displayPn: "+15557654321" });
  const row = humanBindingStatus(ownerMemoryTicket()).bindings.find(item => item.origin.userId === CONTACT)!;
  expect(row.state).toBe("link-required");
  expect(row.display).toMatchObject({ name: "Ana" });
});

it("revoking the connection deactivates every WhatsApp binding of it and a relink starts unlinked", () => {
  const id = ensureOwnerLinked(binding);
  revokeHumanConnection("whatsapp", "conn-1");
  expect(() => resolveHumanBinding(id)).toThrow("HUMAN_LINK_REQUIRED");
});

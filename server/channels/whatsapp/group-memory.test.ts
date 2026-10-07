// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Design 5.1 / 5.4: a group runs on its own guest principal. At the memory policy level the turn reaches the group's
// conversation scope only: nothing of the owner's (bot, team, preferences, shares) and nothing of any participant,
// even a participant the owner linked to a person for DMs.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../../config.ts";
import { closeDatabase } from "../../database.ts";
import { Store } from "../../store.ts";
import { InternalCapabilities } from "../../internal-capabilities.ts";
import { ownerMemoryTicket } from "../../memory/authority.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster } from "../../memory/policy.ts";
import { threadCaptureScope } from "../../memory/capture-scope.ts";
import { WORKSPACE_OWNER, humanBindingStatus, humanTask, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, shareHumanScope, threadHumanPrincipal, type HumanPrincipal } from "../../human-principals.ts";
import { ensureGroupGuest, whatsappOrigin } from "./people.ts";
import type { WhatsAppBinding } from "./event.ts";

const GROUP = "120363000000000000@g.us", OTHER_GROUP = "120363111111111111@g.us";
const BOB = "15557654321@s.whatsapp.net";
const binding: WhatsAppBinding = { connectionId: "conn", linkedPn: "15550001111@s.whatsapp.net", chiefBotId: "chief" } as WhatsAppBinding;

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
const fresh = () => new Store(() => ({ instanceId: "fixture", model: "fixture" }));
function groupPrincipal(jid = GROUP): HumanPrincipal { return resolveHumanBinding(ensureGroupGuest(binding, jid, "Team")); }
function access(store: Store, botId: string, threadId: string, notOwnerAudience: boolean) {
  const roster = () => ({ bots: store.bots, groups: store.groups }); reconcileMemoryRoster(roster());
  const principal = threadHumanPrincipal(threadId), registry = new InternalCapabilities(), generation = registry.begin(botId, threadId, undefined, principal);
  const token = registry.mint({ botId, threadId, generation, depth: 0, kind: "memory", skillAuthoring: false, humanPrincipal: principal, ...(notOwnerAudience ? { notOwnerAudience: true as const } : {}) });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, roster);
}

it("creates one guest person per group, idempotently, labelled with the group, never the owner", () => {
  const first = groupPrincipal(), again = groupPrincipal();
  expect(again).toEqual(first);
  expect(first.personId).not.toBe(WORKSPACE_OWNER);
  expect(groupPrincipal(OTHER_GROUP).personId).not.toBe(first.personId);
});
it("a group or a member can never be linked as the owner", () => {
  const groupId = ensureGroupGuest(binding, GROUP);
  const memberId = observeVerifiedHuman(whatsappOrigin(binding, BOB));
  for (const bindingId of [groupId, memberId]) {
    const revision = resolveHumanBindingRevision(bindingId);
    expect(() => linkHumanBinding(ownerMemoryTicket(), { bindingId, expectedRevision: revision, as: "owner" })).toThrow("HUMAN_OWNER_INELIGIBLE");
  }
});
function resolveHumanBindingRevision(id: string): number {
  return humanBindingStatus(ownerMemoryTicket()).bindings.find(row => row.id === id)!.revision;
}
it("a group thread recalls its own conversation only: no owner bot, team or preference scope, no participant person or share", () => {
  const store = fresh(), bot = store.createBot();
  store.patchBot(bot.id, { section: "sales" } as never);
  // A participant the owner linked to a person for DMs, with a share granted to that person.
  const bobBinding = observeVerifiedHuman(whatsappOrigin(binding, BOB));
  linkHumanBinding(ownerMemoryTicket(), { bindingId: bobBinding, expectedRevision: 1, as: "person" });
  const bob = resolveHumanBinding(bobBinding);
  shareHumanScope(ownerMemoryTicket(), { personId: bob.personId, scopeId: ensureScope("bot", bot.id), granted: true });

  const guest = groupPrincipal(), task = humanTask(store, bot.id, guest)!;
  expect(threadHumanPrincipal(task.threadId)).toEqual(guest);
  expect(task.threadId).not.toBe(bot.threadId);

  const scopes = [...access(store, bot.id, task.threadId, true).scopeIds];
  expect(scopes).toContain(ensureScope("conversation", task.threadId));
  const forbidden = [ensureScope("bot", bot.id), ensureScope("team", "sales"), ensureScope("conversation", bot.threadId),
    ensureScope("preferences", "person:" + WORKSPACE_OWNER), ensureScope("preferences", "person:" + bob.personId)];
  for (const scope of forbidden) expect(scopes).not.toContain(scope);
  // Without the defensive flag the guest principal alone still keeps the owner scopes out.
  const bare = [...access(store, bot.id, task.threadId, false).scopeIds];
  for (const scope of forbidden) expect(bare).not.toContain(scope);
  // The owner's own direct thread, by contrast, does reach the bot scope.
  expect([...access(store, bot.id, bot.threadId, false).scopeIds]).toContain(ensureScope("bot", bot.id));
});
it("two groups never share a thread or a scope, and capture goes to the group's conversation", () => {
  const store = fresh(), bot = store.createBot();
  const a = humanTask(store, bot.id, groupPrincipal(GROUP))!, b = humanTask(store, bot.id, groupPrincipal(OTHER_GROUP))!;
  expect(a.threadId).not.toBe(b.threadId);
  expect(humanTask(store, bot.id, groupPrincipal(GROUP))!.threadId).toBe(a.threadId);
  expect([...access(store, bot.id, a.threadId, true).scopeIds]).not.toContain(ensureScope("conversation", b.threadId));
  expect(threadCaptureScope(a.threadId, { bots: store.bots, groups: store.groups })).toEqual({ kind: "conversation", owner: a.threadId });
});

it("keeps group bindings immutable and excludes their own preferences and shares", () => {
  const store = fresh(), bot = store.createBot(), guest = groupPrincipal();
  const task = humanTask(store, bot.id, guest)!;
  expect(() => linkHumanBinding(ownerMemoryTicket(), { bindingId: guest.bindingId, expectedRevision: guest.revision, as: "person" })).toThrow("HUMAN_GROUP_IMMUTABLE");
  expect(() => shareHumanScope(ownerMemoryTicket(), { personId: guest.personId, scopeId: ensureScope("bot", bot.id), granted: true })).toThrow("HUMAN_GROUP_IMMUTABLE");
  ensureScope("preferences", "person:" + guest.personId);
  for (const flag of [false, true]) expect([...access(store, bot.id, task.threadId, flag).scopeIds]).toEqual([ensureScope("conversation", task.threadId)]);
});

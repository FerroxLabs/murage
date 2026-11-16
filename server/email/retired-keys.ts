// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-ACCOUNT-CHANGE r3 (designs/EMAIL-ACCOUNT-CHANGE-r3.md): which bot key a call may use is named by the database only.
//   - a retired ref {botId, inboxId, keyId} (one cursor row, `retired-keys`) is written in the same transaction that freezes a binding (its
//     inbox is not on the Flux account signed in now); it names the old account's key that the open sends on that inbox are read with, and
//     goes once no open send is left there;
//   - otherwise, for the binding's own inbox, the binding's emailKeyRef.
// The secret file only holds keys (EmailSecretStore, bot slot and retired slot); a key it holds that the database does not name is never used.
import type { EmailStore } from "./email-store.ts";

export const RETIRED_KEYS_SCOPE = "retired-keys";

export interface RetiredKeyRef { botId: string; inboxId: string; keyId: string }

export function readRetiredRefs(raw: string | null): RetiredKeyRef[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is RetiredKeyRef => !!item && typeof item === "object" && typeof item.botId === "string" && typeof item.inboxId === "string" && typeof item.keyId === "string") : [];
  } catch { return []; }
}

export function retiredRefs(store: Pick<EmailStore, "getCursor">, botId?: string): RetiredKeyRef[] {
  const all = readRetiredRefs(store.getCursor(RETIRED_KEYS_SCOPE));
  return botId === undefined ? all : all.filter(ref => ref.botId === botId);
}

/** Writes the whole list (call inside the transaction that makes the change it belongs to). */
export function writeRetiredRefs(store: Pick<EmailStore, "setCursor" | "clearCursor">, refs: RetiredKeyRef[], now: number): void {
  if (refs.length) store.setCursor(RETIRED_KEYS_SCOPE, JSON.stringify(refs), now);
  else store.clearCursor(RETIRED_KEYS_SCOPE);
}

/** A send on this bot's inbox is frozen: the inbox belongs to a Flux account the owner left. Nothing goes out on it; reads use its retired key. */
export function isFrozen(store: Pick<EmailStore, "getCursor">, botId: string, inboxId: string): boolean {
  return retiredRefs(store, botId).some(ref => ref.inboxId === inboxId);
}

/** The key id the database expects for a bot on an inbox (undefined inbox: the binding's own), or null when no key may be used. */
export function expectedBotKey(store: Pick<EmailStore, "getCursor" | "getBinding">, botId: string, inboxId: string | undefined): { keyId: string; inboxId: string | null } | null {
  const binding = store.getBinding(botId);
  const inbox = inboxId ?? binding?.inboxId ?? undefined;
  if (inbox) {
    const retired = retiredRefs(store, botId).find(ref => ref.inboxId === inbox);
    if (retired) return { keyId: retired.keyId, inboxId: inbox };
  }
  if (!binding?.emailKeyRef || (inboxId !== undefined && binding.inboxId !== inboxId)) return null;
  return { keyId: binding.emailKeyRef, inboxId: binding.inboxId };
}

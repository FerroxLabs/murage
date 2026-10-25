// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.4 SL-I: the key a limit is recorded under, shared by the recorder (server/limit-state.ts)
// and the "When a limit resets" picker, so the two can never drift apart.

/** The billing identity a limit belongs to: the account connection, else the engine. */
export function engineKey(selection: { instanceId: string; connectionId?: string; model?: string }): string {
  return selection.connectionId ? `connection:${selection.connectionId}` : `engine:${selection.instanceId}`;
}

export interface LimitEngineOption { key: string; label: string }

/** The picker's options: the bot's own key first (the default), then every engine, then a saved key that is in neither. */
export function limitEngineOptions(
  selection: { instanceId: string; connectionId?: string; model?: string } | undefined,
  instances: ReadonlyArray<{ instanceId: string; displayName: string }>,
  connectedLabel: string,
  savedKey = "",
): LimitEngineOption[] {
  const out: LimitEngineOption[] = [];
  const add = (key: string, label: string) => { if (key && !out.some((option) => option.key === key)) out.push({ key, label }); };
  const nameOf = (id: string) => instances.find((instance) => instance.instanceId === id)?.displayName ?? id;
  if (selection?.instanceId) add(engineKey(selection), selection.connectionId ? `${nameOf(selection.instanceId)} (${connectedLabel})` : nameOf(selection.instanceId));
  for (const instance of instances) add(`engine:${instance.instanceId}`, instance.displayName);
  if (savedKey) add(savedKey, savedKey.startsWith("connection:") ? connectedLabel : nameOf(savedKey.replace(/^engine:/, "")));
  return out;
}

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The model picker's line for a plan sign-in an engine cannot use, so a
// ChatGPT or Grok plan never just goes missing from the list without a word.
import { t } from "@/lib/i18n";
import { signInEngineGap } from "../../shared/provider-engine";
import type { PublicProviderConnection } from "../../shared/provider-connections";

export function signInPickerNote(driverKind: string | undefined, connections: readonly PublicProviderConnection[], selectedConnectionId?: string, now = Date.now()): string {
  const selected = selectedConnectionId ? connections.find(connection => connection.id === selectedConnectionId) : undefined;
  const pausedUntil = selected?.signIn?.pausedUntil;
  if (selected && pausedUntil && pausedUntil > now) return t("modelPicker.signIn.paused", { name: selected.label, time: new Date(pausedUntil).toLocaleString() });
  if (!driverKind || !connections.some(connection => connection.signIn && connection.enabled)) return "";
  const gap = signInEngineGap(driverKind);
  return gap === "claude" ? t("modelPicker.signIn.claude") : gap === "no-connections" ? t("modelPicker.signIn.noConnections") : "";
}

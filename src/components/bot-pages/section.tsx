// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { useState } from "react";
import { type BotSettingsSection } from "../bot-settings-sections";
import { SettingsAskLine } from "../SettingsAskLine";

/** A tab's contents mount the first time it is shown and then stay mounted (its unsaved edits and
 * scroll survive switching away). Hidden tabs that were never opened cost nothing: opening bot
 * settings used to mount and fetch for all fourteen. A deep link (botSettingsIntent) just changes
 * `active`, so its target mounts on arrival. */
export function SettingsSection({ id, active, children }: { id: BotSettingsSection; active?: BotSettingsSection; children?: React.ReactNode }) {
  const shown = active === undefined || active === id;
  const [seen, setSeen] = useState(shown);
  if (shown && !seen) setSeen(true);
  return <section hidden={!shown} data-settings-section={id} className="space-y-4">{seen ? <>{children}<SettingsAskLine /></> : null}</section>;
}

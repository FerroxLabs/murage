// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// General's first card: Advanced mode (SETTINGS-LOCKED-1019.md 2.5). One switch; Off is Simple. The sidebar's footer line
// ("Advanced mode is on · Change") opens this card.
import { sw } from "@/lib/settings-words";
import { setSettingsMode, useSettingsMode } from "@/lib/settings-mode";
import { Switch } from "../SettingsPrimitives";

export const ADVANCED_MODE_ANCHOR = "advanced-mode-heading";

export function AdvancedModeCard() {
  const mode = useSettingsMode();
  const on = mode === "advanced";
  return (
    <div data-settings-mode-card className="rounded-xl border border-accent/40 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div id="advanced-mode-title" className="text-[15px] font-medium text-ink">{sw("settings.mode.title")}</div>
          <p className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">{sw("settings.mode.note")}</p>
        </div>
        <Switch
          checked={on}
          aria-labelledby="advanced-mode-title"
          data-setting-control="advanced-mode-heading"
          onClick={() => setSettingsMode(on ? "simple" : "advanced")}
        />
      </div>
    </div>
  );
}

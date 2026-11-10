// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Can't find it? Ask {Chief}." (SETTINGS-LOCKED-1019 section 10, house rule 4): one quiet line at the bottom of every
// Settings page and every bot section pane. Never a modal, never a nag. Press: leave Settings (asking first when typed
// words are not saved) for the Chief's chat, prefilled "Where in Settings do I ". No bot yet: no line.
import { useStoreIfAny } from "@/state/store";
import { askBotTarget, askYourBot } from "@/lib/health-actions";
import { DISCARD_SETTINGS_CHANGES, settingsDrafts } from "@/lib/settings-drafts";
import { t } from "@/lib/i18n";

export function SettingsAskLine() {
  const store = useStoreIfAny();
  const bots = store?.state.bots ?? [];
  const chief = askBotTarget(bots);
  if (!store || !chief) return null;
  const { dispatch } = store;
  const ask = () => {
    if (settingsDrafts.anyUnsaved() && !window.confirm(DISCARD_SETTINGS_CHANGES)) return;
    settingsDrafts.clear();
    dispatch({ type: "toggleSettings", open: false });
    dispatch({ type: "toggleAppSettings", open: false });
    askYourBot(`${t("settings.askLine.prefill")} `, bots, (id) => dispatch({ type: "select", id }));
  };
  return (
    <p data-settings-ask-line className="pt-2 text-center text-[12.5px] text-ink-secondary">
      <button type="button" onClick={ask} className="rounded underline-offset-2 hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        {t("settings.askLine.text", { chief: chief.name })}
      </button>
    </p>
  );
}

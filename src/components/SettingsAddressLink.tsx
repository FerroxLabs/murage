// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-UX-1011 S8: a murage://settings/... link in a chat reply, a help answer or a tip. A button, never an href:
// the press opens the setting in this window (lib/open-settings-address.ts, loaded on the press) instead of asking the
// system for a handler. A link to a bot that is not here, or a bot row with no bot in view, stays its plain words.
import type { ReactNode } from "react";
import { useStoreIfAny } from "@/state/store";
import type { SettingsAddress } from "@/lib/settings-address";

const linkClass = "[overflow-wrap:anywhere] text-accent underline decoration-accent/40 hover:decoration-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export function SettingsAddressLink({ address, children }: { address: SettingsAddress; children?: ReactNode }) {
  const store = useStoreIfAny();
  if (!store) return <span>{children}</span>;
  const { state, dispatch } = store;
  const botIds = state.bots.map((bot) => bot.id);
  const selectedBotId = state.selectedId && botIds.includes(state.selectedId) ? state.selectedId : null;
  if (address.scope === "bot" && !(address.botId ? botIds.includes(address.botId) : selectedBotId)) return <span>{children}</span>;
  const open = () => {
    void import("@/lib/open-settings-address")
      .then(({ openSettingsAddress }) => { openSettingsAddress(address, { botIds, selectedBotId }, dispatch); })
      .catch((error: unknown) => dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) }));
  };
  return <button type="button" data-settings-address={address.scope} onClick={open} className={linkClass}>{children}</button>;
}

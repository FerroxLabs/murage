import { createContext, useContext, useEffect } from "react";
export interface BotSettingsDraft { dirty: boolean; saving: boolean }
const noDraftPage = () => {};
export const BotSettingsDraftContext = createContext<(key: string, state: BotSettingsDraft | null) => void>(noDraftPage);
/** True inside a bot's settings page (the page provides the draft context). */
export const useInBotSettings = () => useContext(BotSettingsDraftContext) !== noDraftPage;
export const BotSettingsNavigationContext = createContext<(operation: () => void) => void>(operation => operation());
export const useBotSettingsNavigation = () => useContext(BotSettingsNavigationContext);
/** Only state flags cross this boundary, never draft text or credentials. */
export function useBotSettingsDraft(key: string, dirty: boolean, saving = false) {
  const update = useContext(BotSettingsDraftContext);
  useEffect(() => { update(key, { dirty, saving }); return () => update(key, null); }, [key, dirty, saving, update]);
}

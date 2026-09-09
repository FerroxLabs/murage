import { createContext, useContext, useEffect } from "react";
export interface BotSettingsDraft { dirty: boolean; saving: boolean }
export const BotSettingsDraftContext = createContext<(key: string, state: BotSettingsDraft | null) => void>(() => {});
export const BotSettingsNavigationContext = createContext<(operation: () => void) => void>(operation => operation());
export const useBotSettingsNavigation = () => useContext(BotSettingsNavigationContext);
/** Only state flags cross this boundary, never draft text or credentials. */
export function useBotSettingsDraft(key: string, dirty: boolean, saving = false) {
  const update = useContext(BotSettingsDraftContext);
  useEffect(() => { update(key, { dirty, saving }); return () => update(key, null); }, [key, dirty, saving, update]);
}

// 1.0.9 phone tools N3-web: the "Phone for your bots" row in bot settings. It shows only inside the phone app, when this build lists
// `openPhoneForBots`, and when the host offers phone tools (GET /api/phones/offered `flag`). Everywhere else it renders nothing.
// The click asks the app to open its own native screen; there are no arguments and nothing comes back.
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { callNative, inNativeShell, nativeAvailable } from "@/lib/native-shell";

export function phoneForBotsVisible(input: { method: boolean; offered: boolean | null }): boolean {
  return input.method === true && input.offered === true;
}

export async function openPhoneForBotsScreen(): Promise<void> {
  try { await callNative("openPhoneForBots"); } catch { /* an app that cannot open it leaves the page as it was */ }
}

export function PhoneForBotsView({ visible, onOpen }: { visible: boolean; onOpen: () => void }) {
  if (!visible) return null;
  return <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4" data-testid="phone-for-bots-row">
    <div>
      <div className="text-[15px] font-medium text-ink">{t("settings.bot.phoneForBots.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("settings.bot.phoneForBots.description")}</div>
    </div>
    <button type="button" onClick={onOpen} className="min-h-11 rounded-lg bg-inset px-4 py-2 text-[13px] text-ink">{t("settings.bot.phoneForBots.open")}</button>
  </div>;
}

export function PhoneForBotsRow() {
  const [method, setMethod] = useState(false);
  const [offered, setOffered] = useState<boolean | null>(null);
  useEffect(() => {
    if (!inNativeShell()) return;
    let active = true;
    void (async () => {
      try {
        const has = await nativeAvailable("openPhoneForBots");
        if (!active || !has) return;
        const answer = await api("/api/phones/offered");
        if (!active) return;
        setOffered(answer?.flag === true);
        setMethod(true);
      } catch { /* stays hidden */ }
    })();
    return () => { active = false; };
  }, []);
  return <PhoneForBotsView visible={phoneForBotsVisible({ method, offered })} onOpen={() => { void openPhoneForBotsScreen(); }} />;
}

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS v1 (1.0.18, MurageMain ruling): on the card No limits raises for a turn on an engine Murage does not see in
// full (the server writes `outsideEngine` on that card only, server/approval-card-why.ts outsideEngineCard), one plain
// line says why it still asks and which engines show their tools, and Switch to Fuigo moves this bot to Fuigo the way the
// sign-in wall's "Use Fuigo instead" does (POST /api/bots/:id/use-fuigo, with the engineRev the card was drawn with).
// The button shows only on the desktop (the route is desktop-only) and when Fuigo can answer now.
import { useState } from "react";
import { api, useStoreIfAny, type Bot, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { useDesktopSurface } from "@/lib/use-surface";
import { PRIMARY_BUTTON, offersFuigo, runFuigoTap } from "./UseFuigoInstead";

type SwitchBot = Pick<Bot, "id" | "threadId" | "engineRev">;

/** One press of Switch to Fuigo: the existing use-fuigo move. Empty when it landed, else the server's words. */
export function switchToFuigo(bot: SwitchBot, call: typeof api = api): Promise<string> {
  return runFuigoTap(bot, call);
}

export function OutsideEngineNote({ card, bot }: { card: Message["card"] | undefined; bot?: Pick<Bot, "id" | "threadId" | "engineRev" | "modelSelection"> }) {
  const instances = useStoreIfAny()?.state.instances ?? [];
  const desktop = useDesktopSurface();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const engine = card?.outsideEngine;
  if (!engine || typeof engine.name !== "string" || !engine.name.trim()) return null;
  const offer = desktop === true && bot !== undefined && bot.modelSelection !== undefined && offersFuigo(bot, instances);
  const press = async () => {
    if (!bot) return;
    setBusy(true); setNote("");
    try { setNote(await switchToFuigo(bot)); } finally { setBusy(false); }
  };
  return (
    <div data-outside-engine={engine.driver} className="mt-2">
      <p className="text-[12.5px] leading-relaxed text-ink-secondary">{t("noLimits.v1.engineAsks", { engine: engine.name })}</p>
      {offer && (
        <button type="button" data-switch-fuigo className={`mt-2 ${PRIMARY_BUTTON}`} disabled={busy} onClick={() => void press()}>
          {t("noLimits.v1.switchToFuigo")}
        </button>
      )}
      {note ? <p role="status" className="mt-2 text-[12px] text-ink-secondary">{note}</p> : null}
    </div>
  );
}

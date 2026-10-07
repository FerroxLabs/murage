// SPDX-License-Identifier: AGPL-3.0-or-later
// The bot's activity in the owner's browser, one line per action (spec section 5). Shows when, where, what and
// who decided. Typed text never appears, only its length; a name taken from the page is marked as such.
import { useEffect, useState } from "react";
import { api, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";

export type ActivityLine = { at: number; site: string; action: string; target?: string; fromPage?: boolean; decision: string; textLength?: number };
const DECISIONS: Record<string, "browserExt.decision.free" | "browserExt.decision.allowedTask" | "browserExt.decision.youAllowed" | "browserExt.decision.youDenied" | "browserExt.decision.yourTurn" | "browserExt.decision.intentCard" | "browserExt.decision.notDone" | "browserExt.decision.fullPermissive"> = {
  "free": "browserExt.decision.free", "allowed for this task": "browserExt.decision.allowedTask", "you allowed": "browserExt.decision.youAllowed", "you denied": "browserExt.decision.youDenied",
  "your turn": "browserExt.decision.yourTurn", "intent card": "browserExt.decision.intentCard", "not done": "browserExt.decision.notDone", "Full permissive": "browserExt.decision.fullPermissive" };
const clock = (at: number, timeZone?: string) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(at);

export function BrowserActivityLogView({ botName, lines, timeZone }: { botName: string; lines: ActivityLine[]; timeZone?: string }) {
  return <section aria-label={t("browserExt.panel.activity")} className="flex flex-col gap-2 text-sm text-ink">
    <h4 className="font-medium">{t("browserExt.panel.activity")}</h4>
    {!lines.length && <p className="text-ink-secondary">{t("browserExt.activity.empty", { bot: botName })}</p>}
    <ol className="flex flex-col gap-2">{lines.map((line, index) => {
      const decision = DECISIONS[line.decision] ? t(DECISIONS[line.decision]) : line.decision;
      const what = [line.action, line.target, typeof line.textLength === "number" ? t("browserExt.activity.typed", { count: line.textLength }) : ""].filter(Boolean).join(" ");
      return <li key={`${line.at}-${index}`} className="break-words text-ink-secondary">{t("browserExt.activity.line", { time: clock(line.at, timeZone), site: line.site, action: what, decision })}{line.fromPage && <span className="ml-1 text-xs">({t("browserExt.activity.fromPage")})</span>}</li>;
    })}</ol>
  </section>;
}

export function BrowserActivityLog({ bot, bindingId }: { bot: Pick<Bot, "id" | "name">; bindingId?: string }) {
  const [lines, setLines] = useState<ActivityLine[]>([]);
  const url = `/api/bots/${encodeURIComponent(bot.id)}/browser-extension/activity${bindingId ? `?bindingId=${encodeURIComponent(bindingId)}` : ""}`;
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => { try { const result = await api(url); if (alive && Array.isArray(result.activity)) setLines(result.activity.slice(-50).reverse()); } catch { /* keep the last list */ } finally { if (alive) timer = setTimeout(refresh, 5000); } };
    void refresh(); return () => { alive = false; clearTimeout(timer); };
  }, [url]);
  return <BrowserActivityLogView botName={bot.name} lines={lines} />;
}

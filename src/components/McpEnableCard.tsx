// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "Turn on <name>?" card for a server a bot filed switched off (item 118,
// design MCP-118-175 118-3). It shows exactly what would run or where it
// connects; the owner's click is the only way it turns on, and the server
// checks again that the entry is the one the card shows and that no key is
// still waiting. Names and an address only, never a value.
import { useState } from "react";
import { Check, CirclePower, Loader2, ServerCog, X } from "lucide-react";

import { api, type Message } from "@/state/store";
import { t } from "@/lib/i18n";

type Post = (path: string, init: { method: string; body: string }) => Promise<unknown>;

/** Run one card action; resolves the sentence to show, or null when it worked. */
export async function mcpEnableCardAction(post: Post, botId: string, messageId: string, threadId: string, action: "enable" | "dismiss"): Promise<string | null> {
  try {
    await post(`/api/bots/${encodeURIComponent(botId)}/mcp-enable-cards/${encodeURIComponent(messageId)}/${action}`, { method: "POST", body: JSON.stringify({ threadId }) });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function McpEnableCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const card = message.card?.mcpEnable;
  const [busy, setBusy] = useState<"enable" | "dismiss" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  if (!card) return null;
  const closed = Boolean(message.card?.dismissed);
  if (closed && !card.error) return null;
  const enabled = card.enabled === true;
  const error = localError ?? card.error;
  const detail = card.kind === "remote" ? `${card.url ?? ""} (${card.transport ?? "http"})` : [card.command ?? "", ...(card.args ?? [])].join(" ");

  const run = async (action: "enable" | "dismiss") => {
    setBusy(action);
    setLocalError(null);
    setLocalError(await mcpEnableCardAction(api, botId, message.id, threadId, action));
    setBusy(null);
  };

  return (
    <div className="flex w-full justify-start">
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm" data-testid="mcp-enable-card">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-control text-ink"><ServerCog size={19} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">{t("mcp.enable.title", { name: card.name })}</span>
              {enabled && <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"><Check size={11} /> {t("mcp.row.on")}</span>}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
              {enabled ? t("mcp.enable.on", { name: card.name }) : card.kind === "remote" ? t("mcp.enable.link", { bot: card.bot }) : t("mcp.enable.command", { bot: card.bot })}
            </p>
            <code className="mt-1.5 block break-all rounded-md bg-inset px-2 py-1.5 font-mono text-[11.5px] text-ink-secondary">{detail}</code>
            {!enabled && !closed && card.pendingKeys.length > 0 && (
              <p className="mt-1 text-[12px] text-ink-secondary">{t("mcp.enable.pending", { names: card.pendingKeys.join(", ") })}</p>
            )}
            {!enabled && !closed && <p className="mt-1 text-[12px] text-ink-secondary">{t("mcp.enable.off")}</p>}
            {error && <p role="alert" className="mt-2 text-[12px] text-danger">{closed ? t("mcp.card.stale") : error}</p>}
          </div>
          {!enabled && !closed && (
            <button onClick={() => void run("dismiss")} disabled={busy !== null} aria-label={t("mcp.enable.notNow")} title={t("mcp.enable.notNow")} className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50">
              {busy === "dismiss" ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
            </button>
          )}
        </div>
        {!enabled && !closed && (
          <div className="flex items-center justify-end gap-2 border-t border-hairline/40 bg-panel/40 px-4 py-2.5">
            <button
              onClick={() => void run("enable")}
              disabled={busy !== null}
              className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50 sm:min-h-0 sm:w-auto"
            >
              {busy === "enable" ? <Loader2 size={13} className="animate-spin" /> : <CirclePower size={13} />} {t("mcp.enable.turnOn")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

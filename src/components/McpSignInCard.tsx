// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The chat card for a link server whose sign-in ended while a bot was working
// (spec MCP-LINK 3.12, 7.4). On the desktop its button signs in through the
// desktop shell and the task carries on; on a phone or the browser door there
// is no shell, so it says where to finish instead of offering a button that
// could not work. The card holds names and a host, never a token.
import { useState } from "react";
import { Check, KeyRound, Loader2, X } from "lucide-react";

import { api, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { mcpBridge } from "@/lib/mcp-bridge";

/** Close the card. From the browser door the route is the computer's alone, so
 * a refusal is said out loud instead of leaving the card standing silently
 * (review L8). Resolves the sentence to show, or null when it closed. */
export async function dismissSignInCard(
  post: (path: string, init: { method: string; body: string }) => Promise<unknown>,
  endpoint: string,
  threadId: string,
): Promise<string | null> {
  try {
    await post(`${endpoint}/dismiss`, { method: "POST", body: JSON.stringify({ threadId }) });
    return null;
  } catch {
    return t("mcp.signin.dismissFailed");
  }
}

export function McpSignInCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const card = message.mcpSignIn!;
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  if (card.dismissed) return null;

  const endpoint = `/api/bots/${encodeURIComponent(botId)}/mcp-sign-in-cards/${encodeURIComponent(message.id)}`;
  const bridge = mcpBridge();
  const signedIn = card.status === "signed-in";
  const error = localError ?? card.error;

  const signIn = async () => {
    if (!bridge) return;
    setBusy(true);
    setLocalError(null);
    try {
      const result = await bridge.signIn(card.name);
      if (!result.ok) {
        if (result.error !== "cancelled") setLocalError(result.message);
        return;
      }
      await api(`${endpoint}/resume`, { method: "POST", body: JSON.stringify({ threadId }) });
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setLocalError(await dismissSignInCard(api, endpoint, threadId));
  };

  return (
    <div className="flex w-full justify-start">
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm" data-testid="mcp-sign-in-card">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-control text-ink"><KeyRound size={19} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">{t("mcp.signin.title", { host: card.host })}</span>
              {signedIn && <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"><Check size={11} /> {t("mcp.row.on")}</span>}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
              {signedIn ? t("mcp.signin.signedIn", { bot: card.bot }) : t("mcp.signin.body", { name: card.name, bot: card.bot })}
            </p>
            {!signedIn && !bridge && <p className="mt-1 text-[12px] text-ink-secondary">{t("mcp.signin.phone")}</p>}
            {busy && <p role="status" className="mt-1 text-[12px] text-ink-secondary">{t("mcp.signin.waiting")}</p>}
            {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
          </div>
          {!signedIn && (
            <button onClick={() => void dismiss()} aria-label={t("mcp.signin.dismiss")} title={t("mcp.signin.dismiss")} className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink">
              <X size={15} />
            </button>
          )}
        </div>
        {!signedIn && bridge && (
          <div className="flex items-center justify-end border-t border-hairline/40 bg-panel/40 px-4 py-2.5">
            <button
              onClick={() => void signIn()}
              disabled={busy}
              className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50 sm:min-h-0 sm:w-auto"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} {t("mcp.signin.button")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

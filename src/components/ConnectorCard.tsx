import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, PlugZap, RefreshCw, X } from "lucide-react";

import { api, type Message } from "@/state/store";
import { openExternalPage } from "@/lib/open-external";
import { useAction } from "@/lib/use-action";
import { ActionStatus } from "./ActionButton";
import { endConnectorWait, startConnectorPoll } from "@/lib/connector-card-poll";
import {
  CONNECT_APP_DEFAULT_LABEL,
  connectLabelTaken,
  firstFreeConnectLabel,
  readConnectAppStatus,
  type ConfirmedConnectLabel,
} from "@/lib/connect-app";
import { ConnectLabelForm } from "./ConnectLabelForm";

async function openConnectionPage(url: string) {
  await openExternalPage(url, "Your browser blocked the connection page. Allow pop-ups, then try again.");
}

/**
 * The label the card's form opens with (#758).
 *
 * A bot may suggest one when it asks for the app; it is only a suggestion.
 * On a card nobody has confirmed yet, it becomes the first label no account
 * on that app holds ("work", then "work 2"...), and "personal" when the bot
 * named none. Once the person confirmed a label, the card holds that one, and
 * "Open again" or "Try again" fills it in as it is.
 */
export function connectorCardInitialLabel(
  connector: { alias?: string; status: string },
  accounts: readonly { alias?: string; status?: string }[] | undefined,
): string {
  const suggested = connector.alias?.trim() || CONNECT_APP_DEFAULT_LABEL;
  return connector.status === "required" ? firstFreeConnectLabel(accounts, suggested) : suggested;
}

/** The app's own name, without the label the card's title carries. */
export function connectorCardAppName(connector: { label: string; alias?: string }): string {
  const suffix = connector.alias ? ` (${connector.alias})` : "";
  return suffix && connector.label.endsWith(suffix) ? connector.label.slice(0, -suffix.length) : connector.label;
}

/** What the card's authorize request carries: the thread, and the label the
 *  form confirmed. Only a confirmed label fits. */
export function connectorCardAuthorizeBody(threadId: string, alias: ConfirmedConnectLabel): string {
  return JSON.stringify({ threadId, alias });
}

export function ConnectorCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const connector = message.connector!;
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  /** the poll ended without a sign-in: the card stops waiting, whatever the transcript says yet */
  const [timedOut, setTimedOut] = useState(false);
  /** The label form, open with this label; null while closed. A sign-in
   *  starts only from the label confirmed there. */
  const [labelForm, setLabelForm] = useState<{ initial: string; taken?: string } | null>(null);

  const endpoint = `/api/bots/${encodeURIComponent(botId)}/connector-cards/${encodeURIComponent(message.id)}`;
  const checkStatus = useCallback(async () => {
    const result = await api(`${endpoint}/status?threadId=${encodeURIComponent(threadId)}`);
    return { connected: Boolean(result.connected), failed: result.failed === true };
  }, [endpoint, threadId]);

  /** The poll's budget is spent: the server marks the card timed out (or
   * connected, if the sign-in finished just now) and says the sentence. */
  const pollEnded = useCallback(() => endConnectorWait({
    show: ({ timedOut: ended, error }) => {
      setTimedOut(ended);
      setLocalError(error || null);
    },
    notify: () => api(`${endpoint}/timeout`, { method: "POST", body: JSON.stringify({ threadId }) }),
  }), [endpoint, threadId]);

  useEffect(() => {
    if (connector.status !== "authorizing" || connector.dismissed) return;
    return startConnectorPoll({ check: checkStatus, onTimeout: pollEnded });
  }, [checkStatus, pollEnded, connector.dismissed, connector.status]);

  // A fresh attempt starts a fresh wait.
  useEffect(() => {
    if (connector.status === "authorizing") setTimedOut(false);
  }, [connector.status]);

  const dismissAction = useAction(async () => {
    await api(`${endpoint}/dismiss`, { method: "POST", body: JSON.stringify({ threadId }) });
  }, { pending: "Dismissing…", success: null, failure: "Could not dismiss this card. Try again." });

  if (connector.dismissed) return null;

  /** Connect, Open again and Try again open the label form; nothing is
   *  authorized yet. The accounts already on the app pick a free label. */
  const askLabel = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const status = connector.status === "required" ? await readConnectAppStatus(connector.slug, api) : undefined;
      setLabelForm({ initial: connectorCardInitialLabel(connector, status?.accounts) });
    } finally {
      setBusy(false);
    }
  };

  const connect = async (alias: ConfirmedConnectLabel) => {
    setBusy(true);
    setLocalError(null);
    setTimedOut(false);
    try {
      const result = await api(`${endpoint}/authorize`, {
        method: "POST",
        body: connectorCardAuthorizeBody(threadId, alias),
      });
      setLabelForm(null);
      await openConnectionPage(String(result.url));
    } catch (error) {
      if (connectLabelTaken(error)) {
        // Said on the form, holding the label, so another one is one edit away.
        setLabelForm({ initial: alias, taken: alias });
      } else {
        setLabelForm(null);
        setLocalError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, { method: "POST", body: JSON.stringify({ threadId }) });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const connected = connector.status === "connected";
  const authorizing = connector.status === "authorizing" && !timedOut;
  const failed = connector.status === "failed" || timedOut;
  const error = localError ?? connector.error;

  return (
    <div className="flex w-full justify-start">
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-control text-[16px] font-semibold text-ink">
            {connector.label.slice(0, 1).toUpperCase() || <PlugZap size={19} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">{connector.label}</span>
              {connected && (
                <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                  <Check size={11} /> Connected
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
              {connected
                ? connector.resumed
                  ? "Connected securely. Your bot is continuing the task."
                  : "Connected securely. Continue the paused task when you're ready."
                : connector.description}
            </p>
            {!connected && (
              <p className="mt-1 text-[11.5px] text-ink-secondary/80">
                Sign in or enter the app key on the secure connection page, never in chat.
              </p>
            )}
            {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}
            <ActionStatus action={dismissAction} className="mt-2" />
          </div>
          {!connected && (
            <button onClick={() => void dismissAction.run()} disabled={dismissAction.pending} aria-busy={dismissAction.pending} aria-label={dismissAction.pending ? "Dismissing" : "Not now"} title="Not now" className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50">
              {dismissAction.pending ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
            </button>
          )}
        </div>
        {!connected && labelForm && (
          <div className="border-t border-hairline/40 px-4 pb-3">
            <ConnectLabelForm
              key={`${labelForm.initial}:${labelForm.taken ?? ""}`}
              id={message.id}
              service={connectorCardAppName(connector)}
              initial={labelForm.initial}
              takenLabel={labelForm.taken}
              busy={busy}
              onConfirm={(alias) => void connect(alias)}
              onCancel={() => setLabelForm(null)}
            />
          </div>
        )}
        <div className="flex items-center justify-between border-t border-hairline/40 bg-panel/40 px-4 py-2.5">
          <div className="flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
            {authorizing ? <Loader2 size={12} className="animate-spin" /> : <PlugZap size={12} />}
            {authorizing ? "Waiting for sign-in…" : connected ? "Ready to use" : "Requested by your bot"}
          </div>
          {!connected ? (
            <button
              onClick={() => void askLabel()}
              disabled={busy || Boolean(labelForm)}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy || authorizing ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
              {authorizing ? "Open again" : failed ? "Try again" : "Connect securely"}
            </button>
          ) : !connector.resumed ? (
            <button
              onClick={() => void resume()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Continue task
            </button>
          ) : (
            <span className="flex items-center gap-1 text-[12px] font-medium text-success"><Check size={13} /> Continuing</span>
          )}
        </div>
      </div>
    </div>
  );
}

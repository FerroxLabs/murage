import { useState, type FormEvent } from "react";
import { Check, ExternalLink, KeyRound, Loader2, LockKeyhole, RefreshCw, X } from "lucide-react";

import { MCP_CARD_STALE, credentialConfigPatch, credentialResumeOutcome, parseMcpCredentialId, type CredentialTargetId } from "../../shared/credential-request";
import { cn } from "@/lib/cn";
import { useAction } from "@/lib/use-action";
import { ActionStatus } from "./ActionButton";
import { api, useStore, type ConfigStatus, type Message } from "@/state/store";
import { opensPurchasePages } from "@/lib/native-shell";
import { usableMcpBridge } from "@/lib/mcp-bridge";
import { t } from "@/lib/i18n";

/** Item 118: save one key of a server a bot filed. Packaged: through the
 * desktop shell, bound to the card's revision (main refuses a stale one before
 * it writes anything). No shell (dev, headless): to the card's own route,
 * which keeps it in config.json as that run keeps every value. */
export async function saveMcpCardValue(
  deps: { api: typeof api; bridge: () => ReturnType<typeof usableMcpBridge> },
  card: { name: string; key: string; rev: string },
  endpoint: string,
  threadId: string,
  value: string,
): Promise<void> {
  const bridge = await deps.bridge();
  if (!bridge) {
    await deps.api(`${endpoint}/value`, { method: "POST", body: JSON.stringify({ threadId, value }) });
    return;
  }
  const listing = await deps.api("/api/mcp/servers") as { servers?: Array<{ name?: string; kind?: string }> };
  const server = listing.servers?.find((row) => row.name === card.name);
  if (!server) throw new Error(t("mcp.card.stale"));
  const input = server.kind === "remote" ? { headers: { [card.key]: value } } : { env: { [card.key]: value } };
  const saved = await bridge.saveSecrets(card.name, { ...input, rev: card.rev });
  if (!saved.ok) throw new Error(saved.error === "stale" ? t("mcp.card.stale") : saved.message);
}

export function SecretRequestCard({
  botId,
  threadId,
  message,
}: {
  botId: string;
  threadId: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const secret = message.secret!;
  const mcp = parseMcpCredentialId(secret.target);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedLocally, setSavedLocally] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/secret-cards/${encodeURIComponent(message.id)}`;
  const error = localError ?? secret.error;
  const dismissAction = useAction(async () => {
    await api(`${endpoint}/dismiss`, { method: "POST", body: JSON.stringify({ threadId }) });
  }, { pending: "Dismissing…", success: "Dismissed", failure: "Could not dismiss this request. Try again." });
  const outcome = credentialResumeOutcome(secret);
  const provided = outcome === "provided";
  const declined = outcome === "dismissed";
  const description = provided
    ? secret.resumed
      ? "Saved securely. Your bot is continuing the task."
      : "Saved securely. Your bot will continue when its current turn settles."
    : declined
      ? "You chose not to provide this credential. Murage could not resume the bot yet."
      : secret.description;
  const footerLabel = declined
    ? "Continuing without this credential failed"
    : secret.resumed
      ? "Bot resumed without seeing the key"
      : error
        ? "The key is stored; resuming failed"
        : "Waiting to resume";

  // Item 118: a card whose server changed after it was made saves nothing; it
  // says so and offers no field.
  if (mcp && secret.dismissed && secret.error === MCP_CARD_STALE) {
    return (
      <div className="flex w-full justify-start">
        <div className="w-full max-w-[520px] rounded-2xl border border-hairline/50 bg-card px-4 py-3 shadow-sm" data-testid="mcp-credential-stale">
          <div className="truncate text-[14px] font-semibold text-ink">{secret.label}</div>
          <p role="status" className="mt-0.5 text-[12.5px] text-ink-secondary">{t("mcp.card.stale")}</p>
        </div>
      </div>
    );
  }

  // A successful decline has no durable card to show. If its continuation
  // failed, bring the card back with the same retry affordance as a saved key.
  if (declined && (secret.resumed || !error)) return null;

  const notifyProvided = async () => {
    await api(`${endpoint}/provided`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
  };

  const retryResume = async () => {
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving || (!value.trim() && !savedLocally)) return;
    setSaving(true);
    setLocalError(null);
    try {
      if (!savedLocally) {
        const next = value.trim();
        if (mcp) {
          await saveMcpCardValue({ api, bridge: usableMcpBridge }, mcp, endpoint, threadId, next);
        } else {
          const target = secret.target as CredentialTargetId;
          const status: ConfigStatus = window.muragebox?.setCredential
            ? await window.muragebox.setCredential(target, next)
            : await api("/api/config", {
                method: "PUT",
                body: JSON.stringify(credentialConfigPatch(target, next)),
              });
          dispatch({ type: "configStatus", config: status });
        }
        setValue("");
        setSavedLocally(true);
      }
      await notifyProvided();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex w-full justify-start">
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-control text-ink">
            <KeyRound size={19} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">{secret.label}</span>
              {provided && (
                <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                  <Check size={11} /> Saved
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">
              {description}
            </p>
            {!provided && !declined && (
              <p className="mt-1 flex items-center gap-1 text-[11.5px] text-ink-secondary/80">
                <LockKeyhole size={11} /> Stored securely by Murage and never added to chat.
              </p>
            )}
            {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
            <ActionStatus action={dismissAction} className="mt-2" />
          </div>
          {!provided && !declined && (
            <button
              onClick={() => void dismissAction.run()}
              disabled={dismissAction.pending}
              aria-busy={dismissAction.pending}
              aria-label={dismissAction.pending ? "Dismissing" : "Not now"}
              title="Not now"
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50"
            >
              {dismissAction.pending ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
            </button>
          )}
        </div>
        {!provided && !declined && (
          <form onSubmit={(event) => void save(event)} className="border-t border-hairline/40 bg-panel/40 px-4 py-3">
            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={secret.placeholder}
                disabled={saving || savedLocally}
                aria-label={secret.label}
                className="min-w-0 flex-1 rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={saving || (!value.trim() && !savedLocally)}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <LockKeyhole size={13} />}
                {savedLocally ? "Continue task" : "Save securely"}
              </button>
            </div>
            {opensPurchasePages() && secret.helpUrl && <a
              href={secret.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
            >
              Where to get this key <ExternalLink size={11} />
            </a>}
          </form>
        )}
        {(provided || declined) && (
          <div className={cn(
            "flex items-center justify-between border-t border-hairline/40 bg-panel/40 px-4 py-2.5 text-[11.5px]",
            declined ? "text-danger" : "text-success",
          )}>
            <span className="flex items-center gap-1.5">
              {secret.resumed ? <Check size={12} /> : error ? <KeyRound size={12} /> : <Loader2 size={12} className="animate-spin" />}
              {footerLabel}
            </span>
            {!secret.resumed && error && (
              <button
                onClick={() => void retryResume()}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Try again
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

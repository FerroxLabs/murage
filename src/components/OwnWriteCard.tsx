import { useState } from "react";
import { PencilLine } from "lucide-react";
import { api, type Message } from "@/state/store";
import { respondWithFreshAuth } from "@/lib/fresh-auth";
import { t } from "@/lib/i18n";
export function OwnWriteCard({ threadId, message }: { threadId: string; message: Message }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const card = message.card, writer = card?.writer;
  if (!card || !writer) return null;
  const answer = async (behavior: "allow" | "deny") => {
    setBusy(true); setError("");
    const body = { requestId: card.requestId, behavior, stateRevision: writer.stateRevision };
    const post = (extra?: Record<string, unknown>) => api(`/api/threads/${encodeURIComponent(threadId)}/respond`, { method: "POST", body: JSON.stringify({ ...body, ...extra }) });
    try {
      if (behavior === "allow") await respondWithFreshAuth(post, { threadId, requestId: card.requestId!, decision: "allow", card, reason: card.title });
      else await post();
    } catch (caught) { setError(caught instanceof Error ? caught.message : t("ownWrite.unavailable")); }
    finally { setBusy(false); }
  };
  return <section className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4" data-testid="own-write-card">
    <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><PencilLine size={16} aria-hidden />{t("ownWrite.title")}</h3>
    <p className="mt-1 text-[13px] text-ink-secondary">{t(`ownWrite.${writer.state}` as "ownWrite.waiting")}</p>
    <p className="mt-1 text-[12px] text-ink-secondary">{writer.ref}</p>
    <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset p-3 text-[13px] text-ink">{writer.detail}</pre>
    {writer.restored && <p className="mt-2 text-[13px] text-ink-secondary">{t("ownWrite.restored")}</p>}
    {error && <p role="alert" className="mt-2 text-[13px] text-warning">{error}</p>}
    {writer.state === "waiting" && <div className="mt-3 flex flex-wrap gap-2">
      {!writer.restored && <button type="button" disabled={busy} onClick={() => void answer("allow")} className="min-h-11 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50">{t("ownWrite.allow")}</button>}
      <button type="button" disabled={busy} onClick={() => void answer("deny")} className="min-h-11 rounded-lg border border-hairline/50 px-4 py-2 text-[13px] text-ink disabled:opacity-50">{t("ownWrite.deny")}</button>
    </div>}
  </section>;
}

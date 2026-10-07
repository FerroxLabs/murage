// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The inline card for putting a site online or taking one down. One obvious
// action, plain words, no modal. It never offers "always allow": a public site
// is the owner's decision each time. Phones and the browser door see it
// read-only with a pointer to the computer, because the computer running
// Murage is where this is approved. The same card then shows honest progress
// (uploading, checking it loads, live) and, if something goes wrong, one plain
// sentence and the next step.
import { useEffect, useState, type FormEvent } from "react";
import { Check, ChevronDown, ExternalLink, Globe, Loader2, Monitor, Plug, X } from "lucide-react";
import { api, useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useDesktopSurface } from "@/lib/use-surface";
import { openExternalPage } from "@/lib/open-external";
import { readPublishCard, type PublishCardData, type PublishFailure } from "../../shared/publish-card";
import { NETLIFY_TOKEN_PAGE } from "../../shared/published-sites";
import { usableMcpBridge, type McpBridge } from "@/lib/mcp-bridge";
import { connectWithSignIn, connectWithToken, type ConnectResult, type NeedsTokenWhy } from "@/lib/netlify-connect";

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
export const countFiles = (n: number) => t(n === 1 ? "publish.files.one" : "publish.files.many", { count: String(n) });
const FAILURE: Record<PublishFailure, [LocaleKey, LocaleKey]> = {
  reconnect: ["publish.fail.reconnect", "publish.next.reconnect"],
  wait: ["publish.fail.wait", "publish.next.wait"],
  "too-big": ["publish.fail.tooBig", "publish.next.tooBig"],
  "name-taken": ["publish.fail.nameTaken", "publish.next.nameTaken"],
  "not-live": ["publish.fail.notLive", "publish.next.notLive"],
  other: ["publish.fail.other", "publish.next.other"],
};
/** The one plain sentence and the next step for a failure. */
export function failureCopy(failure: PublishFailure | undefined): { sentence: string; next: string } {
  const [sentence, next] = FAILURE[failure ?? "other"];
  return { sentence: t(sentence), next: t(next) };
}
const host = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

export interface PublishCardViewProps {
  data: PublishCardData;
  title: string;
  /** card.answered: "allow", "deny", "unavailable", "failed", or nothing while it waits. */
  settled?: string;
  /** true on the computer running Murage; anything else is read-only. */
  desktop: boolean | undefined;
  filesOpen?: boolean;
  onToggleFiles?: () => void;
  onAnswer?: (behavior: "allow" | "deny") => void;
  onOpen?: () => void;
  error?: string;
}

export function PublishCardView({ data, title, settled, desktop, filesOpen = false, onToggleFiles, onAnswer, onOpen, error }: PublishCardViewProps) {
  const takeDown = data.action === "take-down";
  const progress = data.progress;
  const files = data.files ?? [];
  const count = files.length;
  const waiting = !settled && !progress;
  const name = data.siteName ?? host(data.url).split(".")[0];
  const frame = cn("w-full max-w-[840px] rounded-2xl border bg-card p-4", waiting ? "border-accent/40" : "border-hairline/30", settled === "deny" || settled === "unavailable" ? "opacity-70" : "");
  const steps: Array<{ key: string; label: string; done: boolean }> = [];
  if (progress && !takeDown && progress.step !== "failed" && progress.step !== "taken-down") {
    const n = progress.fileCount ?? count;
    const at = progress.step === "uploading" ? 0 : progress.step === "checking" ? 1 : 2;
    steps.push({ key: "uploading", label: t(n === 1 ? "publish.progress.uploading.one" : "publish.progress.uploading.many", { count: String(n) }), done: at > 0 });
    if (at >= 1) steps.push({ key: "checking", label: t("publish.progress.checking"), done: at > 1 });
    if (at >= 2) steps.push({ key: "live", label: t("publish.progress.live", { url: data.url }), done: true });
  }
  const failure = progress?.step === "failed" ? failureCopy(progress.failure) : null;
  return (
    <div data-publish-card={data.action} data-publish-state={progress?.step ?? (settled ?? "waiting")} className={frame}>
      <div className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Globe size={16} className="shrink-0 text-accent" aria-hidden />{title}</div>

      {waiting && (<>
        {takeDown ? (
          <p className="mt-2 break-words text-[13px] leading-relaxed text-ink">{t(data.deployId ? "publish.takeDown.version" : "publish.takeDown.body", { url: data.url })}</p>
        ) : (<>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-ink-secondary">{t("publish.name")}</dt><dd className="break-words text-ink">{name}</dd>
            <dt className="text-ink-secondary">{t("publish.address")}</dt><dd className="break-all font-medium text-ink">{data.url}</dd>
            <dt className="text-ink-secondary">{t("publish.files")}</dt><dd className="text-ink">{countFiles(count)}, {formatSize(data.totalBytes ?? 0)}</dd>
          </dl>
          {count > 0 && (
            <div className="mt-2">
              <button type="button" onClick={onToggleFiles} aria-expanded={filesOpen} data-publish-files-toggle
                className="inline-flex min-h-9 items-center gap-1 rounded-md text-[12.5px] text-ink-secondary hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                <ChevronDown size={14} className={filesOpen ? "rotate-180" : ""} aria-hidden />{t(filesOpen ? "publish.files.hide" : "publish.files.show")}
              </button>
              {filesOpen && (
                <ul aria-label={t("publish.files")} className="mt-1 max-h-48 overflow-auto rounded-lg bg-inset px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
                  {files.map(file => <li key={file.path} className="flex justify-between gap-3"><span className="min-w-0 break-all">{file.path}</span><span className="shrink-0 text-ink-secondary">{formatSize(file.size)}</span></li>)}
                </ul>
              )}
            </div>
          )}
          {data.skipped && data.skipped.length > 0 && <p className="mt-2 break-words text-[12.5px] text-ink-secondary">{t("publish.skipped", { names: data.skipped.join(", ") })}</p>}
          <p className="mt-2 text-[13px] font-medium text-ink">{t("publish.public")}</p>
        </>)}
        {desktop === true && onAnswer && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" data-choice="allow" onClick={() => onAnswer("allow")}
              className="inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-[13.5px] font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              {t(takeDown ? "publish.action.takeDown" : data.action === "update" ? "publish.action.update" : "publish.action.publish")}
            </button>
            <button type="button" data-choice="deny" onClick={() => onAnswer("deny")}
              className="inline-flex min-h-11 items-center rounded-full border border-hairline px-4 text-[13.5px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              {t("publish.action.notNow")}
            </button>
          </div>
        )}
        {desktop === false && (
          <div data-publish-phone className="mt-3 flex items-start gap-2 rounded-lg bg-inset px-3 py-2 text-[13px] text-ink">
            <Monitor size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden />
            <div><div className="font-medium">{t("publish.phone.title")}</div><div className="text-ink-secondary">{t("publish.phone.body")}</div></div>
          </div>
        )}
        {error && <p role="alert" className="mt-2 text-[12.5px] text-danger">{error}</p>}
      </>)}

      {steps.length > 0 && (
        <ol aria-live="polite" className="mt-3 space-y-1.5 text-[13.5px]">
          {steps.map((step, index) => (
            <li key={step.key} className="flex items-center gap-2 text-ink">
              {step.done ? <Check size={14} className="shrink-0 text-success" aria-hidden /> : <Loader2 size={14} className="shrink-0 animate-spin text-accent" aria-hidden />}
              <span className={cn("min-w-0 break-words", index === steps.length - 1 && step.key === "live" ? "font-medium" : "")}>{step.label}</span>
            </li>
          ))}
        </ol>
      )}
      {progress?.step === "live" && onOpen && (
        <div className="mt-3"><button type="button" data-publish-open onClick={onOpen}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent px-5 text-[13.5px] font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          <ExternalLink size={14} aria-hidden />{t("publish.progress.open")}</button></div>
      )}
      {progress?.step === "taken-down" && <p role="status" className="mt-3 flex items-center gap-2 text-[13.5px] text-ink"><Check size={14} className="text-success" aria-hidden />{t("publish.progress.takenDown")}</p>}
      {failure && (
        <div role="status" data-publish-failure={progress?.failure ?? "other"} className="mt-3 text-[13.5px]">
          <p className="text-ink">{failure.sentence}</p>
          <p className="mt-0.5 text-ink-secondary">{failure.next}</p>
        </div>
      )}
      {!progress && settled === "allow" && <p role="status" className="mt-3 flex items-center gap-2 text-[13.5px] text-ink"><Loader2 size={14} className="animate-spin text-accent" aria-hidden />{t("publish.progress.starting")}</p>}
      {!progress && settled === "deny" && <p role="status" className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary"><X size={14} aria-hidden />{t("publish.settled.declined")}</p>}
      {!progress && settled === "unavailable" && <p role="status" className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary"><X size={14} aria-hidden />{t("publish.settled.unanswered")}</p>}
    </div>
  );
}

/** One card kind, two jobs: the Connect Netlify card, and the approval card for a publish or take-down. */
export function PublishCard({ threadId, message }: { threadId: string; message: Message }) {
  const data = readPublishCard(message.card);
  if (data?.action === "connect") return <ConnectNetlifyCard threadId={threadId} message={message} state={data.connect?.state ?? "needed"} />;
  return <ApprovalCard threadId={threadId} message={message} />;
}

/** Wired to the store: answers through the same route every approval uses. */
function ApprovalCard({ threadId, message }: { threadId: string; message: Message }) {
  const data = readPublishCard(message.card);
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  const [filesOpen, setFilesOpen] = useState(false);
  const [error, setError] = useState("");
  if (!data || !message.card) return null;
  const card = message.card;
  const answer = (behavior: "allow" | "deny") => {
    setError("");
    if (!card.requestId) return;
    dispatch({ type: "decideRequest", threadId, requestId: card.requestId, behavior, message: behavior === "deny" ? "The owner chose not to." : undefined, onError: (reason: string) => setError(reason) });
  };
  const open = () => { openExternalPage(data.url, t("publish.open.blocked")).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); };
  const title = t(data.action === "take-down" ? "publish.title.takeDown" : data.action === "update" ? "publish.title.update" : "publish.title.publish");
  return <PublishCardView data={data} title={title} settled={card.answered} desktop={desktop} filesOpen={filesOpen} onToggleFiles={() => setFilesOpen(value => !value)} onAnswer={answer} onOpen={open} error={error || undefined} />;
}

// ---- Connect Netlify (in chat, on the desktop) ----

const WHY: Record<NeedsTokenWhy, LocaleKey> = {
  "sign-in-not-enough": "publish.connect.why.signInNotEnough",
  "no-shell": "publish.connect.why.noShell",
  "token-rejected": "publish.connect.why.tokenRejected",
  "token-shape": "publish.connect.why.tokenShape",
  unreachable: "publish.connect.why.unreachable",
  "save-failed": "publish.connect.why.saveFailed",
};

export interface ConnectNetlifyViewProps {
  state: "needed" | "connected";
  /** true on the computer running Murage; anything else is read-only. */
  desktop: boolean | undefined;
  step: "start" | "signing-in" | "checking" | "token";
  /** The desktop shell can run the Netlify sign-in. */
  shell: boolean;
  why?: NeedsTokenWhy;
  error?: string;
  onSignIn?: () => void;
  onUseToken?: () => void;
  onBack?: () => void;
  /** The pasted value, handed over once. The field is emptied; it is never kept in the page. */
  onSaveToken?: (token: string) => void;
  onOpenPage?: () => void;
}

const buttonPrimary = "inline-flex min-h-11 items-center rounded-full bg-accent px-5 text-[13.5px] font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const buttonQuiet = "inline-flex min-h-11 items-center rounded-full border border-hairline px-4 text-[13.5px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

export function ConnectNetlifyView({ state, desktop, step, shell, why, error, onSignIn, onUseToken, onBack, onSaveToken, onOpenPage }: ConnectNetlifyViewProps) {
  const connected = state === "connected";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget, value = String(new FormData(form).get("token") ?? "");
    form.reset();
    onSaveToken?.(value);
  };
  return (
    <div data-publish-card="connect" data-connect-state={connected ? "connected" : step} className={cn("w-full max-w-[840px] rounded-2xl border bg-card p-4", connected ? "border-hairline/30" : "border-accent/40")}>
      <div className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Plug size={16} className="shrink-0 text-accent" aria-hidden />{t("publish.connect.title")}</div>
      {connected ? (
        <p role="status" className="mt-2 flex items-center gap-2 text-[13.5px] text-ink"><Check size={14} className="shrink-0 text-success" aria-hidden />{t("publish.connect.connected")}</p>
      ) : (<>
        <p className="mt-2 text-[13.5px] text-ink">{t("publish.connect.body")}</p>
        <p data-connect-allows className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{t("publish.connect.allows")} {t("publish.connect.private")}</p>
        {desktop === false && (
          <div data-publish-phone className="mt-3 flex items-start gap-2 rounded-lg bg-inset px-3 py-2 text-[13px] text-ink">
            <Monitor size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden /><div>{t("publish.connect.phone")}</div>
          </div>
        )}
        {desktop === true && step === "start" && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {shell && <button type="button" data-connect-signin onClick={onSignIn} className={buttonPrimary}>{t("publish.connect.signIn")}</button>}
            <button type="button" data-connect-use-token onClick={onUseToken} className={shell ? "min-h-11 rounded-md px-1 text-[13px] text-ink-secondary underline underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" : buttonPrimary}>{t("publish.connect.useToken")}</button>
          </div>
        )}
        {desktop === true && (step === "signing-in" || step === "checking") && (
          <p role="status" className="mt-3 flex items-center gap-2 text-[13.5px] text-ink"><Loader2 size={14} className="shrink-0 animate-spin text-accent" aria-hidden />{t(step === "signing-in" ? "publish.connect.signingIn" : "publish.connect.checking")}</p>
        )}
        {desktop === true && step === "token" && (
          <form onSubmit={submit} className="mt-3" data-connect-token-form>
            {why && <p role="status" className="mb-2 text-[13px] text-ink">{t(WHY[why])}</p>}
            <label htmlFor="netlify-token" className="block text-[13px] font-medium text-ink">{t("publish.connect.tokenLabel")}</label>
            <input id="netlify-token" name="token" type="password" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} required
              className="mt-1 min-h-11 w-full rounded-lg border border-hairline bg-inset px-3 text-[14px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
            <p className="mt-1.5 text-[12.5px] text-ink-secondary">{t("publish.connect.tokenHow")}</p>
            <a href={NETLIFY_TOKEN_PAGE} target="_blank" rel="noreferrer noopener" data-connect-token-page onClick={event => { event.preventDefault(); onOpenPage?.(); }}
              className="mt-1 inline-flex min-h-9 items-center gap-1 text-[12.5px] text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><ExternalLink size={12} aria-hidden />{t("publish.connect.tokenLink")}</a>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="submit" data-connect-save className={buttonPrimary}>{t("publish.connect.save")}</button>
              {shell && <button type="button" onClick={onBack} className={buttonQuiet}>{t("publish.connect.back")}</button>}
            </div>
          </form>
        )}
        {error && <p role="alert" className="mt-2 break-words text-[12.5px] text-danger">{error}</p>}
      </>)}
    </div>
  );
}

/** Wired up: the sign-in and the token go through src/lib/netlify-connect.ts, and the server settles the card. */
function ConnectNetlifyCard({ threadId, message, state }: { threadId: string; message: Message; state: "needed" | "connected" }) {
  const desktop = useDesktopSurface();
  const [bridge, setBridge] = useState<McpBridge | undefined>();
  const [shellKnown, setShellKnown] = useState(false);
  const [step, setStep] = useState<ConnectNetlifyViewProps["step"]>("start");
  const [why, setWhy] = useState<NeedsTokenWhy | undefined>();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => { let live = true; void usableMcpBridge().then(found => { if (live) { setBridge(found); setShellKnown(true); } }); return () => { live = false; }; }, []);
  const context = { threadId, messageId: message.id };
  const settle = (result: ConnectResult) => {
    setError(""); setWhy(undefined);
    if (result.state === "connected") { setDone(true); return; }
    if (result.state === "start") { setStep("start"); setError(result.problem ? t("publish.connect.why.unreachable") : result.error ?? ""); return; }
    setStep("token"); setWhy(result.why); setError(result.error ?? "");
  };
  const deps = { api: (path: string, init?: { method?: string; body?: string }) => api(path, init), bridge };
  const signIn = async () => { setError(""); setStep("signing-in"); const result = await connectWithSignIn(deps, context); if (result.state === "needs-token" || result.state === "connected") setStep("checking"); settle(result); };
  const saveToken = async (token: string) => { setError(""); setStep("checking"); settle(await connectWithToken(deps, token, context)); };
  const useToken = () => { setError(""); setWhy(undefined); setStep("token"); };
  const openPage = () => { openExternalPage(NETLIFY_TOKEN_PAGE, t("publish.open.blocked")).catch(() => setError(t("publish.open.blocked"))); };
  if (!shellKnown && desktop === true) return <ConnectNetlifyView state={state} desktop={desktop} step="start" shell={false} />;
  return <ConnectNetlifyView state={done ? "connected" : state} desktop={desktop} step={step} shell={bridge !== undefined} {...(why ? { why } : {})} {...(error ? { error } : {})}
    onSignIn={() => void signIn()} onUseToken={useToken} onBack={() => { setStep("start"); setWhy(undefined); setError(""); }} onSaveToken={token => void saveToken(token)} onOpenPage={openPage} />;
}

// ---- Sites this bot published (bot settings, Access) ----

export interface SiteRow { siteId: string; name: string; url: string; lastPublishedAt: number; lastFileCount: number; origin: "created" | "assigned"; needsAttention?: true }

export function PublishedSitesView({ botName, sites, desktop, confirming, busy, error, addError, adding, onOpen, onAsk, onCancel, onConfirm, onAdd }: {
  botName: string; sites: SiteRow[]; desktop: boolean | undefined; confirming?: string; busy?: boolean; error?: string; addError?: string; adding?: boolean;
  onOpen?: (site: SiteRow) => void; onAsk?: (site: SiteRow) => void; onCancel?: () => void; onConfirm?: (site: SiteRow) => void; onAdd?: (site: string) => void;
}) {
  return (
    <section aria-labelledby="published-sites-title" data-published-sites className="rounded-xl bg-card p-4">
      <h3 id="published-sites-title" className="text-[15px] font-medium text-ink">{t("publish.sites.title")}</h3>
      {sites.length === 0 && <p className="mt-1 text-[12.5px] text-ink-secondary">{t("publish.sites.empty", { bot: botName })}</p>}
      <ul className="mt-2 space-y-3">
        {sites.map(site => (
          <li key={site.siteId} className="rounded-lg border border-hairline/40 p-3">
            <div className="break-all text-[13.5px] font-medium text-ink">{site.url}</div>
            {site.needsAttention ? (
              <div data-site-attention className="mt-0.5 text-[12.5px]"><span className="font-medium text-danger">{t("publish.sites.attention")}</span><span className="text-ink-secondary"> {t("publish.sites.attention.body")}</span></div>
            ) : (
              <div className="mt-0.5 text-[12px] text-ink-secondary">
                {site.lastPublishedAt > 0 ? t("publish.sites.meta", { files: countFiles(site.lastFileCount), when: new Date(site.lastPublishedAt).toLocaleDateString() }) : t("publish.sites.given")}
              </div>
            )}
            {confirming === site.siteId ? (
              <div className="mt-2" role="group" aria-label={t("publish.sites.confirm", { url: site.url })}>
                <p className="break-words text-[13px] text-ink">{t("publish.sites.confirm", { url: site.url })}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" data-confirm-take-down disabled={busy} onClick={() => onConfirm?.(site)} className="min-h-10 rounded-full bg-danger px-4 text-[13px] font-medium text-white disabled:opacity-50">{t("publish.sites.confirmYes")}</button>
                  <button type="button" disabled={busy} onClick={onCancel} className="min-h-10 rounded-full border border-hairline px-4 text-[13px] text-ink disabled:opacity-50">{t("publish.sites.keep")}</button>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" data-open-site onClick={() => onOpen?.(site)} className="inline-flex min-h-10 items-center gap-1 rounded-full border border-hairline px-4 text-[13px] text-ink"><ExternalLink size={13} aria-hidden />{t("publish.sites.open")}</button>
                {desktop === true && <button type="button" data-take-down onClick={() => onAsk?.(site)} className="min-h-10 rounded-full border border-danger/40 px-4 text-[13px] text-danger">{t("publish.sites.takeDown")}</button>}
              </div>
            )}
          </li>
        ))}
      </ul>
      {sites.length > 0 && desktop === false && <p className="mt-2 text-[12px] text-ink-secondary">{t("publish.sites.phone")}</p>}
      {error && <p role="alert" className="mt-2 text-[12.5px] text-danger">{error}</p>}
      {desktop === true && onAdd && (
        <form data-add-site-form className="mt-4 border-t border-hairline/40 pt-3" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget, value = String(new FormData(form).get("site") ?? "").trim(); if (value) { onAdd(value); } }}>
          <div className="text-[13.5px] font-medium text-ink">{t("publish.sites.add.title")}</div>
          <p className="mt-0.5 text-[12.5px] text-ink-secondary">{t("publish.sites.add.help", { bot: botName })}</p>
          <label htmlFor="add-site-input" className="sr-only">{t("publish.sites.add.label")}</label>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input id="add-site-input" name="site" type="text" data-add-site-input required maxLength={300} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={t("publish.sites.add.placeholder")}
              className="min-h-10 min-w-0 flex-1 basis-56 rounded-lg border border-hairline bg-inset px-3 text-[13.5px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" />
            <button type="submit" data-add-site disabled={adding} className="min-h-10 rounded-full bg-accent px-4 text-[13px] font-medium text-white disabled:opacity-50">{t(adding ? "publish.sites.add.working" : "publish.sites.add.button")}</button>
          </div>
          {addError && <p role="alert" className="mt-2 break-words text-[12.5px] text-danger">{addError}</p>}
        </form>
      )}
    </section>
  );
}

export function PublishedSitesPanel({ bot }: { bot: Bot }) {
  const desktop = useDesktopSurface();
  const [sites, setSites] = useState<SiteRow[] | null>(null);
  const [confirming, setConfirming] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let live = true; setSites(null); setConfirming(undefined); setAddError("");
    api(`/api/bots/${encodeURIComponent(bot.id)}/published-sites`).then(result => { if (live) setSites(Array.isArray(result?.sites) ? result.sites : []); }).catch(() => { if (live) setSites([]); });
    return () => { live = false; };
  }, [bot.id]);
  const takeDown = async (site: SiteRow) => {
    setBusy(true); setError("");
    try { const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/published-sites/${encodeURIComponent(site.siteId)}/take-down`, { method: "POST", body: "{}" }); setSites(result.sites ?? []); setConfirming(undefined); }
    catch { setError(t("publish.sites.failed")); } finally { setBusy(false); }
  };
  const open = (site: SiteRow) => { openExternalPage(site.url, t("publish.open.blocked")).catch(() => setError(t("publish.open.blocked"))); };
  const add = async (reference: string) => {
    setAdding(true); setAddError("");
    try { const result = await api(`/api/bots/${encodeURIComponent(bot.id)}/published-sites`, { method: "POST", body: JSON.stringify({ site: reference }) }); setSites(result.sites ?? []); }
    catch (cause) {
      const code = (cause as { body?: { code?: string } } | null)?.body?.code;
      setAddError(code === "not-found" ? t("publish.sites.add.notFound") : code === "bad-name" ? t("publish.sites.add.badName") : code === "reconnect" ? t("publish.sites.add.reconnect", { bot: bot.name }) : t("publish.sites.add.failed"));
    } finally { setAdding(false); }
  };
  if (sites === null || (sites.length === 0 && desktop !== true)) return null;
  return <PublishedSitesView botName={bot.name} sites={sites} desktop={desktop} confirming={confirming} busy={busy} error={error || undefined} addError={addError || undefined} adding={adding} onAdd={reference => void add(reference)} onOpen={open} onAsk={site => setConfirming(site.siteId)} onCancel={() => setConfirming(undefined)} onConfirm={site => void takeDown(site)} />;
}

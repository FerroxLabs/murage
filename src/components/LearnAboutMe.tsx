// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings > Memory > Learn about me. The owner copies Murage's export prompt,
// runs it in the assistant they used before and pastes the answer here. The
// paste is parsed in this window (shared/learn-about-me/parse.ts, code, never a
// model) and nothing reaches the server until the owner keeps a line: each Keep
// is one `remember` owner action. The review list lives only in this window.
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { LAM_MAX_CHARS, LAM_MAX_LINE, LAM_MAX_LINES, LAM_PROVIDERS, parseExport, type LamFlag, type LamLine, type LamProvider, type LamSection } from "../../shared/learn-about-me/parse";
import { LAM_EXPORT_PROMPT } from "../../shared/learn-about-me/prompt";
import { LAM_PROVIDER_NAMES } from "../../shared/learn-about-me/origin";
import { memoryButtonClass, memoryInputClass, type MemoryAction } from "./MemoryReview";
import { errorSentence } from "@/lib/memory-review";
import { clearLamText, peekLamText } from "@/lib/lam-handoff";

export type LamStatus = "waiting" | "kept" | "known" | "skipped" | "forgotten";
export interface LamReviewLine extends LamLine {
  draft: string; status: LamStatus; actionId: string;
  /** The words last sent with this action id: once sent, the id stays with the line, so a retry after a lost answer is the same Keep. */
  sent?: string; recordId?: string; error?: string; busy?: boolean;
}
export type LamGroup = "instructions" | "about" | "projects" | "unsorted";
export const LAM_GROUPS: readonly LamGroup[] = ["instructions", "about", "projects", "unsorted"];
const GROUP_OF: Record<LamSection, LamGroup> = { instructions: "instructions", identity: "about", career: "about", projects: "projects", preferences: "projects", unsorted: "unsorted" };
const GROUP_TITLE: Record<LamGroup, LocaleKey> = { instructions: "learnAboutMe.group.instructions", about: "learnAboutMe.group.about", projects: "learnAboutMe.group.projects", unsorted: "learnAboutMe.group.unsorted" };
const FLAG_TEXT: Record<LamFlag, LocaleKey> = { tooLong: "learnAboutMe.flag.tooLong", dateIgnored: "learnAboutMe.flag.dateIgnored", duplicate: "learnAboutMe.flag.duplicate", looksLikeAnInstruction: "learnAboutMe.flag.instruction", mentionsAnotherAssistant: "learnAboutMe.flag.mentionsYou", maskedIdentifier: "learnAboutMe.flag.maskedIdentifier" };

export const lamGroupOf = (line: Pick<LamLine, "section">): LamGroup => GROUP_OF[line.section];
export const providerName = (provider: LamProvider) => provider === "other" ? t("learnAboutMe.provider.other") : LAM_PROVIDER_NAMES[provider];
export function newActionId(): string { return `lam-${globalThis.crypto.randomUUID()}`; }

/** The one request a Keep sends: the exact words the owner sees, and where they came from. */
export function rememberAction(line: Pick<LamReviewLine, "draft" | "date" | "actionId">, provider: LamProvider): MemoryAction {
  return { action: "remember", actionId: line.actionId, text: line.draft.trim(), origin: { provider, ...(line.date ? { date: line.date } : {}) } };
}
/** Keep all is offered only for Projects and preferences, and takes only waiting lines without a flag. */
export function keepAllLines(lines: readonly LamReviewLine[]): LamReviewLine[] {
  return lines.filter(line => lamGroupOf(line) === "projects" && line.status === "waiting" && !line.flags.length && keepable(line));
}
export const keepable = (line: LamReviewLine) => line.draft.trim().length > 0 && line.draft.trim().length <= LAM_MAX_LINE;
/** A refused Keep or Undo in plain words: the server's own sentence when it sent one, a known code in words, else the usual sentence. */
export function lamErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/MEMORY_IDEMPOTENCY_CONFLICT/.test(text)) return t("learnAboutMe.error.conflict");
  if (/^[A-Z][A-Z0-9_]+$/.test(text) || !text) return errorSentence(error);
  return text;
}
export function reviewLines(lines: readonly LamLine[]): LamReviewLine[] {
  return lines.map(line => ({ ...line, draft: line.text, status: "waiting", actionId: newActionId() }));
}
function refusalText(result: { reason: "tooLong" | "tooManyLines"; chars: number; lines: number }): string {
  return result.reason === "tooLong"
    ? t("learnAboutMe.refused.chars", { count: result.chars.toLocaleString(), limit: LAM_MAX_CHARS.toLocaleString() })
    : t("learnAboutMe.refused.lines", { count: result.lines.toLocaleString(), limit: LAM_MAX_LINES.toLocaleString() });
}

export function LearnAboutMe({ desktop, memoryActive, request, initialReview, initialText }: {
  desktop: boolean | undefined; memoryActive: boolean;
  request: (action: MemoryAction) => Promise<unknown>;
  /** Tests only: a paste already reviewed. */
  initialReview?: { provider: LamProvider; text: string };
  /** A paste from a chat's Review and keep (ExportPasteNote): reviewed as if pasted here, provider Other. Without it, the paste the
   * chat handed over (lam-handoff.ts), read once. Nothing is sent until the owner keeps a line. */
  initialText?: string;
}) {
  const [handed] = useState(() => initialReview ? null : initialText ?? peekLamText());
  useEffect(() => { clearLamText(); }, []);
  const start = initialReview ?? (handed ? { provider: "other" as const, text: handed } : undefined);
  const [provider, setProvider] = useState<LamProvider>(start?.provider ?? "chatgpt");
  const [paste, setPaste] = useState(start?.text ?? "");
  const [copied, setCopied] = useState(false);
  const [refusal, setRefusal] = useState(() => {
    if (!start) return "";
    const parsed = parseExport(start.text);
    return parsed.ok ? "" : refusalText(parsed);
  });
  const [lines, setLines] = useState<LamReviewLine[] | null>(() => {
    if (!start) return null;
    const parsed = parseExport(start.text);
    return parsed.ok ? reviewLines(parsed.lines) : null;
  });
  const [reviewProvider, setReviewProvider] = useState<LamProvider>(start?.provider ?? "chatgpt");
  const unkept = (lines ?? []).some(line => line.status === "waiting");
  useEffect(() => {
    if (!unkept) return;
    const hold = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [unkept]);
  if (desktop !== true) return null;

  const patch = (n: number, change: Partial<LamReviewLine>) => setLines(current => current?.map(line => line.n === n ? { ...line, ...change } : line) ?? current);
  const review = () => {
    if (unkept && !window.confirm(t("learnAboutMe.replaceConfirm"))) return;
    const parsed = parseExport(paste);
    if (!parsed.ok) { setRefusal(refusalText(parsed)); setLines(null); return; }
    setRefusal(""); setReviewProvider(provider); setLines(reviewLines(parsed.lines));
  };
  const keep = async (line: LamReviewLine) => {
    patch(line.n, { busy: true, error: undefined, sent: line.draft });
    try {
      const answer = await request(rememberAction(line, reviewProvider)) as { duplicate?: boolean; record?: { id: string } };
      patch(line.n, { busy: false, status: answer.duplicate ? "known" : "kept", recordId: answer.record?.id });
    } catch (error) {
      patch(line.n, { busy: false, error: lamErrorText(error) });
    }
  };
  const keepAll = async () => { for (const line of keepAllLines(lines ?? [])) await keep(line); };
  const undo = async (line: LamReviewLine) => {
    if (!line.recordId) return;
    patch(line.n, { busy: true, error: undefined });
    try { await request({ action: "forget", kind: "record", id: line.recordId }); patch(line.n, { busy: false, status: "forgotten" }); }
    catch (error) { patch(line.n, { busy: false, error: lamErrorText(error) }); }
  };
  const edit = (line: LamReviewLine, draft: string) => patch(line.n, { draft, ...(line.sent === undefined ? { actionId: newActionId() } : {}) });
  const copy = () => { void navigator.clipboard?.writeText(LAM_EXPORT_PROMPT).then(() => setCopied(true), () => {}); };
  const done = lines !== null && lines.length > 0 && !lines.some(line => line.status === "waiting");

  const lineView = (line: LamReviewLine) => {
    const label = line.date ? t("learnAboutMe.dated", { provider: providerName(reviewProvider), date: line.date }) : t("learnAboutMe.undated", { provider: providerName(reviewProvider) });
    return <li key={line.n} className="space-y-2 rounded-lg border border-hairline/40 p-3" data-lam-line={line.n} data-lam-status={line.status}>
      <p className="text-[12px] text-ink-secondary">{label}</p>
      {line.flags.length > 0 && <ul className="flex flex-wrap gap-2 text-[12px] text-ink-secondary">{line.flags.map(flag => <li key={flag} className="rounded bg-inset px-2 py-0.5">{t(FLAG_TEXT[flag])}</li>)}</ul>}
      {line.status === "waiting"
        ? <label className="block text-[13px]"><span className="sr-only">{t("learnAboutMe.lineText")}</span><textarea className={memoryInputClass} rows={2} value={line.draft} disabled={line.busy} onChange={event => edit(line, event.target.value)} /></label>
        : <p className="whitespace-pre-wrap break-words text-[13px]">{line.status === "forgotten" ? t("learnAboutMe.forgotten") : line.draft}</p>}
      {line.error && <p role="alert" className="break-words text-[12px] text-danger">{line.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {line.status === "waiting" && <>
          <button type="button" className={memoryButtonClass} disabled={line.busy || !memoryActive || !keepable(line)} onClick={() => void keep(line)}>{t("learnAboutMe.keep")}</button>
          <button type="button" className={memoryButtonClass} disabled={line.busy} onClick={() => patch(line.n, { status: "skipped" })}>{t("learnAboutMe.skip")}</button>
        </>}
        {line.status === "kept" && <><span role="status" className="text-[12px]">{t("learnAboutMe.kept")}</span><button type="button" className={memoryButtonClass} disabled={line.busy} onClick={() => void undo(line)}>{t("learnAboutMe.undo")}</button></>}
        {line.status === "known" && <span role="status" className="text-[12px]">{t("learnAboutMe.known")}</span>}
        {line.status === "skipped" && <><span className="text-[12px] text-ink-secondary">{t("learnAboutMe.skipped")}</span><button type="button" className={memoryButtonClass} onClick={() => patch(line.n, { status: "waiting" })}>{t("learnAboutMe.reviewAgain")}</button></>}
      </div>
    </li>;
  };

  return <section aria-labelledby="learn-about-me-heading" className="space-y-3" data-testid="learn-about-me">
    <div><h3 id="learn-about-me-heading" className="text-[14px] font-medium">{t("learnAboutMe.title")}</h3><p className="text-[13px] text-ink-secondary">{t("learnAboutMe.lead")}</p></div>
    <div className="space-y-2 rounded-lg border border-hairline/40 p-3">
      <label className="block space-y-1 text-[13px]">{t("learnAboutMe.promptLabel")}<textarea className={memoryInputClass} rows={6} readOnly value={LAM_EXPORT_PROMPT} data-testid="learn-about-me-prompt" /></label>
      <button type="button" className={memoryButtonClass} onClick={copy}>{copied ? t("learnAboutMe.copied") : t("learnAboutMe.copy")}</button>
      <label className="block space-y-1 text-[13px]">{t("learnAboutMe.provider")}<select className={memoryInputClass} value={provider} onChange={event => setProvider(event.target.value as LamProvider)}>{LAM_PROVIDERS.map(value => <option key={value} value={value}>{providerName(value)}</option>)}</select></label>
      <label className="block space-y-1 text-[13px]"><span className="sr-only">{t("learnAboutMe.pasteLabel")}</span><textarea className={memoryInputClass} rows={6} value={paste} placeholder={t("learnAboutMe.pastePlaceholder")} onChange={event => setPaste(event.target.value)} /></label>
      <button type="button" className={memoryButtonClass} disabled={!paste.trim()} onClick={review}>{t("learnAboutMe.review")}</button>
      {refusal && <p role="alert" className="text-[13px] text-danger">{refusal}</p>}
    </div>
    {lines !== null && <div className="space-y-3" data-testid="learn-about-me-review">
      <p role="note" className="rounded-lg bg-inset p-3 text-[13px]" data-testid="learn-about-me-banner">{t("learnAboutMe.banner")}</p>
      {!memoryActive && <p role="status" className="text-[13px] text-ink-secondary">{t("learnAboutMe.memoryOff")}</p>}
      {!lines.length && <p className="text-[13px] text-ink-secondary">{t("learnAboutMe.nothingFound")}</p>}
      {LAM_GROUPS.map(group => {
        const members = lines.filter(line => lamGroupOf(line) === group);
        if (!members.length) return null;
        return <section key={group} aria-label={t(GROUP_TITLE[group])} className="space-y-2" data-lam-group={group}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-[13px] font-medium">{t(GROUP_TITLE[group])}</h4>
            {group === "projects" && <button type="button" className={memoryButtonClass} disabled={!memoryActive || !keepAllLines(lines).length} onClick={() => void keepAll()}>{t("learnAboutMe.keepAll")}</button>}</div>
          <ul className="space-y-2">{members.map(lineView)}</ul>
        </section>;
      })}
      {done && <p role="status" className="text-[13px]">{t("learnAboutMe.done")}</p>}
    </div>}
  </section>;
}

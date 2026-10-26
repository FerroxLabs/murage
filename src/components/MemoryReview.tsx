import { useState } from "react";
import type { MemoryRecord } from "../../shared/memory";
import { managedInContinuity } from "@/lib/continuity";
import { localeCode, t } from "../lib/i18n";
import type { LocaleKey } from "@/locales";
import { Disclosure } from "./MemoryLearningControls";
import { LAM_PROVIDER_NAMES, rememberedOrigin } from "../../shared/learn-about-me/origin";

export interface MemoryAudience { id: string; kind: string; ownerKey: string; label: string }
export type CorrectionPinChoice = "transfer" | "unpin";
/** The exact fact an agent-proposed correction would replace (server
 * `readCorrectionTarget`). `changed`/`unavailable` cannot be approved. */
export interface MemoryCorrectionReview {
  status: "current" | "changed" | "unavailable";
  target: { id: string; version: number; text: string; state: string; ownerPinned: boolean; scopeId: string } | null;
}
export interface MemoryInspection {
  record: MemoryRecord;
  evidence: Array<{ sourceId: string; revision: number; startByte: number; endByte: number; text: string; path?: string; hash: string; speaker: string }>;
  lineage: Array<{ id: string; version: number }>;
  correction?: MemoryCorrectionReview | null;
}
export type MemoryAction = Record<string, unknown> & { action: string };

/** A record's state, in the words a person uses. */
export const memoryStateLabel = (state: string) => t(({ candidate: "memoryReview.stateWaiting", active: "memoryReview.stateCurrent", archived: "memoryReview.stateArchived", superseded: "memoryReview.stateReplaced", deleted: "memoryReview.stateForgotten" } as Record<string, LocaleKey>)[state] ?? "memoryReview.saved");
/** Who or what a memory rests on. */
export const memoryOriginLabel = (assertion: string) => t(({ "owner-statement": "memoryReview.originOwner", "tool-observation": "memoryReview.originTool", "assistant-inference": "memoryReview.originBot", "unverified-import": "memoryReview.originImport" } as Record<string, LocaleKey>)[assertion] ?? "memoryReview.saved");
/** Who or what a memory rests on, naming the assistant and date for a line kept through Learn about me. */
export function memoryRecordOriginLabel(record: Pick<MemoryRecord, "id" | "assertion" | "validFrom"> & { kind?: string }): string {
  const origin = rememberedOrigin(record.id);
  // a verbatim piece of a chat line (kind source) says so, beside who said it (PASTE-CAPTURE-FIX 6, S6)
  if (!origin && record.kind === "source") return `${t("memoryReview.chatExcerpt")} · ${memoryOriginLabel(record.assertion)}`;
  if (!origin) return memoryOriginLabel(record.assertion);
  const provider = origin.provider === "other" ? t("learnAboutMe.provider.other") : LAM_PROVIDER_NAMES[origin.provider];
  if (origin.precision === "u") return t("learnAboutMe.importedFromUndated", { provider });
  const parts: Intl.DateTimeFormatOptions = origin.precision === "d" ? { day: "numeric", month: "short", year: "numeric" } : origin.precision === "m" ? { month: "short", year: "numeric" } : { year: "numeric" };
  return t("learnAboutMe.importedFrom", { provider, date: new Date(record.validFrom).toLocaleDateString(localeCode(), parts) });
}
/** A forgotten memory keeps no words (memory-revocation.ts affect): say so instead of showing an empty line. */
export const memoryRecordText = (record: Pick<MemoryRecord, "state" | "text">) => record.state === "deleted" && !record.text ? t("memoryReview.forgottenWords") : record.text;
const speakerLabel = (speaker: string) => speaker === "owner" || speaker.startsWith("person:") ? t("memoryReview.speakerYou") : speaker === "tool" ? t("memoryReview.speakerTool") : t("memoryReview.speakerBot");

/** The approve request for a candidate, or null while approval is not allowed.
 * A correction that replaces a pinned fact needs the owner's explicit pin
 * choice; nothing is preselected (decision U-16). */
export function candidateApproval(record: MemoryRecord, correction: MemoryCorrectionReview | null | undefined, pinChoice: CorrectionPinChoice | ""): MemoryAction | null {
  if (record.state !== "candidate") return null;
  const approve = { action: "approve", id: record.id, version: record.version };
  if (!correction) return approve;
  if (correction.status !== "current" || !correction.target) return null;
  if (!correction.target.ownerPinned) return approve;
  return pinChoice ? { ...approve, correctionPin: pinChoice } : null;
}
export const memoryInputClass = "w-full min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
export const memoryButtonClass = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

export function MemoryReview({ inspection, audiences, busy = false, onAction, onClose }: {
  inspection: MemoryInspection; audiences: MemoryAudience[]; busy?: boolean;
  onAction: (action: MemoryAction, success: string) => Promise<void>; onClose: () => void;
}) {
  const { record, evidence, lineage } = inspection;
  const [correction, setCorrection] = useState(record.text);
  const [destination, setDestination] = useState("");
  const [confirmForget, setConfirmForget] = useState(false);
  const [skillBot, setSkillBot] = useState("");
  const [pinChoice, setPinChoice] = useState<CorrectionPinChoice | "">("");
  const audience = audiences.find(item => item.id === record.scopeId)?.label ?? t("memoryReview.unavailableAudience");
  const active = record.state === "active";
  const proposal = record.state === "candidate" ? inspection.correction ?? null : null;
  const approval = candidateApproval(record, proposal, pinChoice);
  const choosePin = proposal?.status === "current" && proposal.target?.ownerPinned === true;
  return <section aria-label={t("memoryReview.detailsTitle")} className="space-y-4 rounded-xl border border-hairline/50 bg-panel p-4" data-memory-detail-id={record.id}>
    <div className="flex items-center justify-between gap-3"><h3 className="text-[15px] font-medium">{t("memoryReview.detailsTitle")}</h3><button className={memoryButtonClass} onClick={onClose}>{t("memoryReview.closeDetails")}</button></div>
    <p className="text-[12px] text-ink-secondary">{audience} · {memoryStateLabel(record.state)} · {memoryRecordOriginLabel(record)} · <time dateTime={new Date(record.validFrom).toISOString()}>{new Date(record.validFrom).toLocaleString()}</time></p>
    {record.assertion === "unverified-import" && <p className="text-[12px] text-ink-secondary">{t("memoryReview.importedNote")}</p>}
    <p className="whitespace-pre-wrap break-words text-[13px]" data-testid="memory-record-text">{memoryRecordText(record)}</p>
    {record.state === "candidate" && record.reviewReason && <p className="text-[12px] text-ink-secondary">{record.reviewReason}</p>}
    <div className="space-y-2">
      <h4 className="text-[13px] font-medium">{t("memoryReview.sources")}</h4>
      {!evidence.length && <p className="text-[12px] text-ink-secondary">{t("memoryReview.noSources")}</p>}
      {evidence.map(source => <Disclosure key={`${source.sourceId}:${source.revision}:${source.startByte}`} label={<span className="break-words font-normal">{source.path ?? t("memoryReview.conversation")} · {speakerLabel(source.speaker)}</span>}>
        <p className="mt-2 whitespace-pre-wrap break-words text-[13px]">{source.text}</p>
      </Disclosure>)}
      {lineage.length > 0 && <p className="text-[12px] text-ink-secondary">{lineage.length === 1 ? t("memoryReview.lineageOne") : t("memoryReview.lineageMany", { count: lineage.length })}</p>}
    </div>
    <fieldset disabled={busy} className="space-y-4">
      <legend className="sr-only">{t("memoryReview.reviewLegend")}</legend>
      {proposal && <div className="space-y-2 rounded-lg border border-hairline/40 p-3" data-testid="memory-correction-review">
        <h4 className="text-[13px] font-medium">{t("memoryCorrection.title")}</h4>
        {proposal.target && <>
          <p className="text-[12px] text-ink-secondary">{t("memoryCorrection.replaces", { version: proposal.target.version })}</p>
          <p className="whitespace-pre-wrap break-words text-[13px]" data-testid="memory-correction-target-text">{proposal.target.text}</p>
        </>}
        {proposal.status === "current" && <p className="text-[12px] text-ink-secondary">{t("memoryCorrection.effect")}</p>}
        {proposal.status === "changed" && <p role="alert" className="text-[12px] text-danger">{t("memoryCorrection.changed")}</p>}
        {proposal.status === "unavailable" && <p role="alert" className="text-[12px] text-danger">{t("memoryCorrection.unavailable")}</p>}
        {choosePin && <fieldset className="space-y-1">
          <legend className="text-[13px]">{t("memoryCorrection.pinLegend")}</legend>
          <label className="flex min-h-10 items-center gap-2 text-[13px]"><input type="radio" name={`memory-correction-pin-${record.id}`} value="transfer" required checked={pinChoice === "transfer"} onChange={() => setPinChoice("transfer")} />{t("memoryCorrection.pinTransfer")}</label>
          <label className="flex min-h-10 items-center gap-2 text-[13px]"><input type="radio" name={`memory-correction-pin-${record.id}`} value="unpin" required checked={pinChoice === "unpin"} onChange={() => setPinChoice("unpin")} />{t("memoryCorrection.pinUnpin")}</label>
          {!pinChoice && <p className="text-[12px] text-ink-secondary">{t("memoryCorrection.pinRequired")}</p>}
        </fieldset>}
      </div>}
      <div className="flex flex-wrap gap-2">
        {record.state === "candidate" && <button className={memoryButtonClass} disabled={!approval} onClick={() => { if (approval) void onAction(approval, proposal ? t("memoryCorrection.approved") : t("memoryReview.kept")); }}>{proposal ? t("memoryCorrection.approve") : t("memoryReview.keep")}</button>}
        {!managedInContinuity(record.kind) && active && <button className={memoryButtonClass} onClick={() => void onAction({ action: "pin", id: record.id, version: record.version, pinned: !record.ownerPinned }, record.ownerPinned ? t("memoryReview.unpinned") : t("memoryReview.pinned"))}>{record.ownerPinned ? t("memoryReview.unpin") : t("memoryReview.pin")}</button>}
      </div>
      {!managedInContinuity(record.kind) && active && <>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void onAction({ action: "review-as-skill", id: record.id, version: record.version, botId: skillBot }, t("memoryReview.skillRequested")); }}>
          <label className="block space-y-1 text-[13px]">{t("memoryReview.botToReview")}<select className={memoryInputClass} value={skillBot} onChange={event => setSkillBot(event.target.value)}><option value="">{t("memoryReview.chooseBot")}</option>{audiences.filter(item => item.kind === "bot").map(item => <option key={item.id} value={item.ownerKey}>{item.label}</option>)}</select></label>
          <p className="text-[12px] text-ink-secondary">{t("memoryReview.learnNote")}</p>
          <button className={memoryButtonClass} disabled={!skillBot}>{t("memoryReview.reviewAsSkill")}</button>
        </form>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void onAction({ action: "correct", id: record.id, version: record.version, text: correction }, t("memoryReview.correctionSaved")); }}>
          <label className="block space-y-1 text-[13px]">{t("memoryReview.correctionText")}<textarea className={memoryInputClass} rows={4} maxLength={4096} value={correction} onChange={event => setCorrection(event.target.value)} /></label>
          <button className={memoryButtonClass} disabled={!correction.trim() || correction === record.text}>{t("memoryReview.saveCorrection")}</button>
        </form>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void onAction({ action: "promote", id: record.id, version: record.version, scopeId: destination }, t("memoryReview.shared")); }}>
          <label className="block space-y-1 text-[13px]">{t("memoryReview.shareWithAudience")}<select className={memoryInputClass} value={destination} onChange={event => setDestination(event.target.value)}><option value="">{t("memoryReview.chooseAudience")}</option>{audiences.filter(item => item.id !== record.scopeId).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <p className="text-[12px] text-ink-secondary">{t("memoryReview.shareNote")}</p>
          <button className={memoryButtonClass} disabled={!destination}>{t("memoryReview.shareMemory")}</button>
        </form>
      </>}
      {managedInContinuity(record.kind) && <p className="text-[12px] text-ink-secondary">{t("memoryReview.managed")}</p>}
      {!managedInContinuity(record.kind) && active && !record.ownerPinned && <button className={memoryButtonClass} onClick={() => void onAction({ action: "archive", id: record.id, version: record.version }, t("memoryReview.archived"))}>{t("memoryReview.archive")}</button>}
      {!managedInContinuity(record.kind) && record.state === "archived" && <button className={memoryButtonClass} onClick={() => void onAction({ action: "restore-archive", id: record.id, version: record.version }, t("memoryReview.restored"))}>{t("memoryReview.restoreArchive")}</button>}
      {!managedInContinuity(record.kind) && record.state !== "deleted" && <div className="space-y-2 border-t border-hairline/40 pt-3">
        <p className="text-[12px] text-ink-secondary">{t("memoryReview.forgetNote")}</p>
        <label className="flex min-h-10 items-center gap-2 text-[13px]"><input type="checkbox" checked={confirmForget} onChange={event => setConfirmForget(event.target.checked)} />{t("memoryReview.confirmForget")}</label>
        <button className={`${memoryButtonClass} text-danger`} disabled={!confirmForget} onClick={() => void onAction({ action: "forget", kind: "record", id: record.id, revision: record.version }, t("memoryReview.forgotten"))}>{t("memoryReview.forget")}</button>
      </div>}
    </fieldset>
  </section>;
}

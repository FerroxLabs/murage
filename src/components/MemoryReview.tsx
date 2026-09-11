import { useState } from "react";
import type { MemoryRecord } from "../../shared/memory";
import { t } from "../lib/i18n";

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

export function MemoryReview({ inspection, audiences, busy, onAction, onClose }: {
  inspection: MemoryInspection; audiences: MemoryAudience[]; busy: boolean;
  onAction: (action: MemoryAction, success: string) => Promise<void>; onClose: () => void;
}) {
  const { record, evidence, lineage } = inspection;
  const [correction, setCorrection] = useState(record.text);
  const [destination, setDestination] = useState("");
  const [confirmForget, setConfirmForget] = useState(false);
  const [skillBot, setSkillBot] = useState("");
  const [pinChoice, setPinChoice] = useState<CorrectionPinChoice | "">("");
  const audience = audiences.find(item => item.id === record.scopeId)?.label ?? "Unavailable audience";
  const active = record.state === "active";
  const proposal = record.state === "candidate" ? inspection.correction ?? null : null;
  const approval = candidateApproval(record, proposal, pinChoice);
  const choosePin = proposal?.status === "current" && proposal.target?.ownerPinned === true;
  return <section aria-label="Memory details" className="space-y-4 rounded-xl border border-hairline/50 bg-panel p-4" data-memory-detail-id={record.id}>
    <div className="flex items-center justify-between gap-3"><h3 className="text-[15px] font-medium">Memory details</h3><button className={memoryButtonClass} onClick={onClose}>Close details</button></div>
    <p className="text-[12px] text-ink-secondary">{audience} · Record: {record.state} · Version {record.version} · {record.assertion.replaceAll("-", " ")} · <time dateTime={new Date(record.validFrom).toISOString()}>{new Date(record.validFrom).toLocaleString()}</time></p>
    {record.assertion === "unverified-import" && <p className="text-[12px] text-ink-secondary">Imported notebook text is reference material. Active means saved for recall, not verified instructions or a change to workspace capture settings.</p>}
    <p className="whitespace-pre-wrap break-words text-[13px]" data-testid="memory-record-text">{record.text}</p>
    <div className="space-y-2">
      <h4 className="text-[13px] font-medium">Sources</h4>
      {!evidence.length && <p className="text-[12px] text-ink-secondary">No linked source excerpts.</p>}
      {evidence.map(source => <details key={`${source.sourceId}:${source.revision}:${source.startByte}`} className="rounded-lg border border-hairline/40 p-3">
        <summary className="cursor-pointer break-words text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">{source.path ?? source.sourceId} · {source.speaker} · Revision {source.revision}</summary>
        <p className="mt-2 whitespace-pre-wrap break-words text-[13px]">{source.text}</p>
        <p className="mt-2 break-all font-mono text-[11px] text-ink-secondary">Source hash: {source.hash}</p>
        <p className="text-[11px] text-ink-secondary">Source bytes {source.startByte}–{source.endByte}</p>
      </details>)}
      {lineage.length > 0 && <p className="break-all text-[12px] text-ink-secondary">Derived from: {lineage.map(item => `${item.id} (version ${item.version})`).join(", ")}</p>}
    </div>
    <fieldset disabled={busy} className="space-y-4">
      <legend className="sr-only">Review memory</legend>
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
        {record.state === "candidate" && <button className={memoryButtonClass} disabled={!approval} onClick={() => { if (approval) void onAction(approval, proposal ? t("memoryCorrection.approved") : "Candidate approved."); }}>{proposal ? t("memoryCorrection.approve") : "Approve candidate"}</button>}
        {active && <button className={memoryButtonClass} onClick={() => void onAction({ action: "pin", id: record.id, version: record.version, pinned: !record.ownerPinned }, record.ownerPinned ? "Memory unpinned." : "Memory pinned.")}>{record.ownerPinned ? "Unpin memory" : "Pin memory"}</button>}
      </div>
      {active && <>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void onAction({ action: "review-as-skill", id: record.id, version: record.version, botId: skillBot }, "Skill review requested in the selected bot's conversation. Any proposed skill still needs your approval."); }}>
          <label className="block space-y-1 text-[13px]">Bot to review this skill<select className={memoryInputClass} value={skillBot} onChange={event => setSkillBot(event.target.value)}><option value="">Choose an authorized bot</option>{audiences.filter(item => item.kind === "bot").map(item => <option key={item.id} value={item.ownerKey}>{item.label}</option>)}</select></label>
          <p className="text-[12px] text-ink-secondary">Starts the existing /learn workflow with this exact memory version as its source. The selected bot must already have access. Its model may incur usage charges; no skill is activated by this action.</p>
          <button className={memoryButtonClass} disabled={!skillBot}>Review as skill</button>
        </form>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void onAction({ action: "correct", id: record.id, version: record.version, text: correction }, "Correction saved as a new version."); }}>
          <label className="block space-y-1 text-[13px]">Correction text<textarea className={memoryInputClass} rows={4} maxLength={4096} value={correction} onChange={event => setCorrection(event.target.value)} /></label>
          <button className={memoryButtonClass} disabled={!correction.trim() || correction === record.text}>Save correction</button>
        </form>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void onAction({ action: "promote", id: record.id, version: record.version, scopeId: destination }, "A separate memory was shared with the selected audience."); }}>
          <label className="block space-y-1 text-[13px]">Share with audience<select className={memoryInputClass} value={destination} onChange={event => setDestination(event.target.value)}><option value="">Choose an audience</option>{audiences.filter(item => item.id !== record.scopeId).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <p className="text-[12px] text-ink-secondary">Sharing creates an approved copy for this audience. Review the text before sharing private information.</p>
          <button className={memoryButtonClass} disabled={!destination}>Share memory</button>
        </form>
      </>}
      {active && !record.ownerPinned && <button className={memoryButtonClass} onClick={() => void onAction({ action: "archive", id: record.id, version: record.version }, "Memory archived. Its sources remain available for historical recall.")}>Archive memory</button>}
      {record.state === "archived" && <button className={memoryButtonClass} onClick={() => void onAction({ action: "restore-archive", id: record.id, version: record.version }, "Memory restored to current recall.")}>Restore to current recall</button>}
      {record.state !== "deleted" && <div className="space-y-2 border-t border-hairline/40 pt-3">
        <p className="text-[12px] text-ink-secondary">Forgetting removes this memory and invalidates dependent recall. Text already sent to an external provider cannot be withdrawn.</p>
        <label className="flex min-h-10 items-center gap-2 text-[13px]"><input type="checkbox" checked={confirmForget} onChange={event => setConfirmForget(event.target.checked)} />Confirm forgetting this memory</label>
        <button className={`${memoryButtonClass} text-danger`} disabled={!confirmForget} onClick={() => void onAction({ action: "forget", kind: "record", id: record.id, revision: record.version }, "Memory forgotten. Dependent recall has been invalidated.")}>Forget memory</button>
      </div>}
    </fieldset>
  </section>;
}

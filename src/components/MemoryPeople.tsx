import { useState } from "react";
import { memoryButtonClass, memoryInputClass } from "./MemoryReview";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

export interface VerifiedHumanOrigin {
  platform: "slack" | "discord" | "telegram" | "whatsapp";
  connectionId: string;
  authorityId: string;
  userId: string;
}
export interface HumanBinding {
  id: string;
  origin: VerifiedHumanOrigin;
  personId: string | null;
  revision: number;
  active: boolean;
  state: "inactive" | "linked" | "link-required";
}
/** A server-read owner share. Absent `shares` means the server did not report them, not that nothing is shared. */
export interface HumanShare { personId: string; scopeId: string; granted: boolean; revision: number }
export interface HumanBindingsStatus { ownerPersonId: string; bindings: HumanBinding[]; shares?: HumanShare[] }
export interface HumanLinkIntent {
  bindingId: string;
  expectedRevision: number;
  as: "owner" | "person" | "unlink";
  personId?: string;
}
export interface HumanShareIntent { personId: string; scopeId: string; granted: boolean }
export interface ShareableAudience { id: string; kind: string; label: string }

export function verifiedAccountLabel(origin: VerifiedHumanOrigin) {
  return t("memoryPeople.accountLabel", { platform: `${origin.platform[0].toUpperCase()}${origin.platform.slice(1)}`, userId: origin.userId, authorityId: origin.authorityId });
}
const isGroup = (binding: HumanBinding) => binding.origin.platform === "whatsapp" && binding.origin.userId.endsWith("@g.us");
export function linkedPersonChoices(bindings: HumanBinding[], ownerPersonId: string, currentBindingId: string) {
  const seen = new Set<string>();
  return bindings.filter(binding => binding.active && !isGroup(binding) && binding.id !== currentBindingId && binding.personId && binding.personId !== ownerPersonId && !seen.has(binding.personId) && (seen.add(binding.personId), true))
    .map(binding => ({ personId: binding.personId!, label: verifiedAccountLabel(binding.origin) }));
}

// Bot, conversation and preference audiences stay private to their owner; only group audiences can be offered to a person.
const SHAREABLE_KINDS: Record<string, LocaleKey> = { room: "memoryPeople.kindChannel", project: "memoryPeople.kindProject", team: "memoryPeople.kindTeam", workspace: "memoryPeople.kindWorkspace" };
export function shareAudienceLabel(audience: ShareableAudience) {
  return t("memoryPeople.audienceLabel", { kind: t(SHAREABLE_KINDS[audience.kind] ?? "memoryPeople.kindAudience"), label: audience.label });
}
/** One row per separate person with a current verified account. Granted audiences come only from server read-back. */
export function personShareRows(people: HumanBindingsStatus, audiences: ShareableAudience[]) {
  const accounts = new Map<string, string[]>();
  for (const binding of people.bindings) if (binding.active && !isGroup(binding) && binding.personId && binding.personId !== people.ownerPersonId)
    accounts.set(binding.personId, [...accounts.get(binding.personId) ?? [], verifiedAccountLabel(binding.origin)]);
  return [...accounts].map(([personId, labels]) => {
    const granted = new Set((people.shares ?? []).filter(share => share.personId === personId && share.granted).map(share => share.scopeId));
    return {
      personId, label: labels.join(" and "),
      granted: [...granted].map(scopeId => audiences.find(audience => audience.id === scopeId) ?? { id: scopeId, kind: "unavailable", label: t("memoryPeople.unavailableAudience") }),
      available: audiences.filter(audience => audience.kind in SHAREABLE_KINDS && !granted.has(audience.id)),
    };
  });
}

export function MemoryPeople({ people, audiences, disabled, onLink, onShare, onRefresh }: {
  people: HumanBindingsStatus;
  audiences?: ShareableAudience[];
  disabled: boolean;
  onLink: (intent: HumanLinkIntent) => Promise<void>;
  onShare?: (intent: HumanShareIntent) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [shareChoices, setShareChoices] = useState<Record<string, string>>({});
  const change = async (intent: HumanLinkIntent) => {
    setBusy(intent.bindingId); setError(undefined); setConflict(false);
    try { await onLink(intent); }
    catch (cause) {
      const detail = cause instanceof Error ? cause.message : t("memoryPeople.errUpdate");
      const stale = detail.includes("MEMORY_VERSION_CONFLICT");
      setConflict(stale); setError(stale ? t("memoryPeople.errStale") : detail);
    } finally { setBusy(undefined); }
  };
  const share = async (intent: HumanShareIntent) => {
    if (!onShare) return;
    setBusy(`share:${intent.personId}`); setError(undefined); setConflict(false);
    try { await onShare(intent); if (intent.granted) setShareChoices(previous => ({ ...previous, [intent.personId]: "" })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("memoryPeople.errShare")); }
    finally { setBusy(undefined); }
  };
  const refresh = async () => {
    setBusy("refresh");
    try { await onRefresh(); setError(undefined); setConflict(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("memoryPeople.errRefresh")); }
    finally { setBusy(undefined); }
  };
  const pending = people.bindings.filter(binding => binding.active && binding.state === "link-required");
  const shareRows = people.shares && audiences && onShare ? personShareRows(people, audiences) : null;
  return <section aria-label={t("memoryPeople.sectionLabel")} className="space-y-3 rounded-lg border border-hairline/40 p-3">
    <div><h3 className="text-[14px] font-medium">{t("memoryPeople.title")}</h3><p className="mt-1 text-[12px] text-ink-secondary">{t("memoryPeople.intro")}</p></div>
    {error && <p role="alert" className="break-words text-[13px] text-danger">{error}</p>}
    {conflict && <button type="button" className={memoryButtonClass} disabled={disabled || Boolean(busy)} onClick={() => void refresh()}>{t("memoryPeople.refresh")}</button>}
    {!people.bindings.length && <p role="status" className="text-[13px] text-ink-secondary">{t("memoryPeople.none")}</p>}
    {pending.length > 0 && <p className="text-[12px] text-ink-secondary">{pending.length === 1 ? t("memoryPeople.pendingOne") : t("memoryPeople.pendingMany", { count: pending.length })}</p>}
    <div className="space-y-3">
      {people.bindings.map(binding => {
        const choicesForBinding = linkedPersonChoices(people.bindings, people.ownerPersonId, binding.id);
        const selectedPersonId = choices[binding.id] ?? "";
        const isBusy = Boolean(busy) || disabled || !binding.active;
        const state = isGroup(binding) ? t("memoryPeople.stateGroup") : !binding.active ? t("memoryPeople.stateInactive") : binding.personId === people.ownerPersonId ? t("memoryPeople.stateOwner") : binding.personId ? t("memoryPeople.stateSeparate") : t("memoryPeople.stateNeedsDecision");
        return <div key={`${binding.id}:${binding.revision}`} className="space-y-2 rounded-lg border border-hairline/40 p-3" role="group" aria-label={verifiedAccountLabel(binding.origin)}>
          <p className="break-words text-[13px]">{verifiedAccountLabel(binding.origin)}</p>
          <p className="text-[12px] text-ink-secondary">{state}</p>
          {binding.active && !isGroup(binding) && <div className="flex flex-wrap gap-2">
            {!(binding.origin.platform === "whatsapp" && binding.origin.userId !== binding.origin.authorityId) && <button type="button" className={memoryButtonClass} disabled={isBusy} onClick={() => void change({ bindingId: binding.id, expectedRevision: binding.revision, as: "owner" })}>{t("memoryPeople.myAccount")}</button>}
            <button type="button" className={memoryButtonClass} disabled={isBusy} onClick={() => void change({ bindingId: binding.id, expectedRevision: binding.revision, as: "person" })}>{t("memoryPeople.separatePerson")}</button>
            {choicesForBinding.length > 0 && <div className="flex min-h-10 items-center gap-2 text-[13px]"><label>{t("memoryPeople.samePersonAs")}<select aria-label={t("memoryPeople.existingAccountFor", { account: verifiedAccountLabel(binding.origin) })} className="ml-2 min-h-10 rounded-md border border-hairline bg-inset px-2 text-[13px]" value={selectedPersonId} disabled={isBusy} onChange={event => setChoices(previous => ({ ...previous, [binding.id]: event.target.value }))}><option value="">{t("memoryPeople.chooseAccount")}</option>{choicesForBinding.map(choice => <option key={choice.personId} value={choice.personId}>{choice.label}</option>)}</select></label><button type="button" className={memoryButtonClass} disabled={isBusy || !selectedPersonId} onClick={() => void change({ bindingId: binding.id, expectedRevision: binding.revision, as: "person", personId: selectedPersonId })}>{t("memoryPeople.link")}</button></div>}
            {binding.personId && <button type="button" className={memoryButtonClass} disabled={isBusy} onClick={() => void change({ bindingId: binding.id, expectedRevision: binding.revision, as: "unlink" })}>{t("memoryPeople.unlink")}</button>}
          </div>}
        </div>;
      })}
    </div>
    {shareRows && shareRows.length > 0 && <div className="space-y-3 border-t border-hairline/40 pt-3">
      <div><h4 className="text-[13px] font-medium">{t("memoryPeople.sharedTitle")}</h4><p className="mt-1 text-[12px] text-ink-secondary">{t("memoryPeople.sharedIntro")}</p></div>
      {shareRows.map(row => {
        const selectedScopeId = shareChoices[row.personId] ?? "";
        const isBusy = Boolean(busy) || disabled;
        return <div key={row.personId} role="group" aria-label={t("memoryPeople.sharedFor", { label: row.label })} className="space-y-2 rounded-lg border border-hairline/40 p-3">
          <p className="break-words text-[13px]">{row.label}</p>
          {row.granted.length ? <ul className="space-y-2">{row.granted.map(audience => <li key={audience.id} className="flex flex-wrap items-center gap-2 text-[13px]"><span className="break-words">{shareAudienceLabel(audience)}</span><button type="button" className={memoryButtonClass} disabled={isBusy} aria-label={t("memoryPeople.stopSharingAria", { audience: shareAudienceLabel(audience), label: row.label })} onClick={() => void share({ personId: row.personId, scopeId: audience.id, granted: false })}>{t("memoryPeople.stopSharing")}</button></li>)}</ul>
            : <p className="text-[12px] text-ink-secondary">{t("memoryPeople.noShared")}</p>}
          {row.available.length > 0 && <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (selectedScopeId) void share({ personId: row.personId, scopeId: selectedScopeId, granted: true }); }}>
            <label className="block space-y-1 text-[13px]">{t("memoryPeople.shareAnAudience")}<select className={memoryInputClass} value={selectedScopeId} disabled={isBusy} onChange={event => setShareChoices(previous => ({ ...previous, [row.personId]: event.target.value }))}><option value="">{t("memoryPeople.chooseAudience")}</option>{row.available.map(audience => <option key={audience.id} value={audience.id}>{shareAudienceLabel(audience)}</option>)}</select></label>
            <button className={memoryButtonClass} disabled={isBusy || !selectedScopeId}>{t("memoryPeople.shareAudience")}</button>
          </form>}
        </div>;
      })}
    </div>}
  </section>;
}

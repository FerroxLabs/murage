import { useState } from "react";
import { memoryButtonClass, memoryInputClass } from "./MemoryReview";

export interface VerifiedHumanOrigin {
  platform: "slack" | "discord" | "telegram";
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
  return `${origin.platform[0].toUpperCase()}${origin.platform.slice(1)} account · user ID ${origin.userId} · authority ${origin.authorityId}`;
}
export function linkedPersonChoices(bindings: HumanBinding[], ownerPersonId: string, currentBindingId: string) {
  const seen = new Set<string>();
  return bindings.filter(binding => binding.active && binding.id !== currentBindingId && binding.personId && binding.personId !== ownerPersonId && !seen.has(binding.personId) && (seen.add(binding.personId), true))
    .map(binding => ({ personId: binding.personId!, label: verifiedAccountLabel(binding.origin) }));
}

// Bot, conversation and preference audiences stay private to their owner; only group audiences can be offered to a person.
const SHAREABLE_KINDS: Record<string, string> = { room: "Room", project: "Project", team: "Team", workspace: "Workspace" };
export function shareAudienceLabel(audience: ShareableAudience) {
  return `${SHAREABLE_KINDS[audience.kind] ?? "Audience"}: ${audience.label}`;
}
/** One row per separate person with a current verified account. Granted audiences come only from server read-back. */
export function personShareRows(people: HumanBindingsStatus, audiences: ShareableAudience[]) {
  const accounts = new Map<string, string[]>();
  for (const binding of people.bindings) if (binding.active && binding.personId && binding.personId !== people.ownerPersonId)
    accounts.set(binding.personId, [...accounts.get(binding.personId) ?? [], verifiedAccountLabel(binding.origin)]);
  return [...accounts].map(([personId, labels]) => {
    const granted = new Set((people.shares ?? []).filter(share => share.personId === personId && share.granted).map(share => share.scopeId));
    return {
      personId, label: labels.join(" and "),
      granted: [...granted].map(scopeId => audiences.find(audience => audience.id === scopeId) ?? { id: scopeId, kind: "unavailable", label: "Unavailable audience" }),
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
      const detail = cause instanceof Error ? cause.message : "Could not update this account. Try again.";
      const stale = detail.includes("MEMORY_VERSION_CONFLICT");
      setConflict(stale); setError(stale ? "This account changed elsewhere. Refresh verified accounts, review the latest assignment, then try again." : detail);
    } finally { setBusy(undefined); }
  };
  const share = async (intent: HumanShareIntent) => {
    if (!onShare) return;
    setBusy(`share:${intent.personId}`); setError(undefined); setConflict(false);
    try { await onShare(intent); if (intent.granted) setShareChoices(previous => ({ ...previous, [intent.personId]: "" })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change this shared audience. Refresh verified accounts, then try again."); }
    finally { setBusy(undefined); }
  };
  const refresh = async () => {
    setBusy("refresh");
    try { await onRefresh(); setError(undefined); setConflict(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not refresh verified accounts. Try again."); }
    finally { setBusy(undefined); }
  };
  const pending = people.bindings.filter(binding => binding.active && binding.state === "link-required");
  const shareRows = people.shares && audiences && onShare ? personShareRows(people, audiences) : null;
  return <section aria-label="Verified people and accounts" className="space-y-3 rounded-lg border border-hairline/40 p-3">
    <div><h3 className="text-[14px] font-medium">People and verified accounts</h3><p className="mt-1 text-[12px] text-ink-secondary">Connect verified platform accounts only when you choose their relationship. Marking an account as yours allows it to use the workspace owner&apos;s context. A separate person stays isolated. Linking accounts joins their person context; it never uses a display name as proof.</p></div>
    {error && <p role="alert" className="break-words text-[13px] text-danger">{error}</p>}
    {conflict && <button type="button" className={memoryButtonClass} disabled={disabled || Boolean(busy)} onClick={() => void refresh()}>Refresh verified accounts</button>}
    {!people.bindings.length && <p role="status" className="text-[13px] text-ink-secondary">No verified platform accounts need an assignment yet.</p>}
    {pending.length > 0 && <p className="text-[12px] text-ink-secondary">{pending.length} verified platform account{pending.length === 1 ? " is" : "s are"} waiting for an owner decision.</p>}
    <div className="space-y-3">
      {people.bindings.map(binding => {
        const choicesForBinding = linkedPersonChoices(people.bindings, people.ownerPersonId, binding.id);
        const selectedPersonId = choices[binding.id] ?? "";
        const isBusy = Boolean(busy) || disabled || !binding.active;
        const state = !binding.active ? "Inactive connection" : binding.personId === people.ownerPersonId ? "Workspace owner" : binding.personId ? "Separate person" : "Needs an owner decision";
        return <div key={`${binding.id}:${binding.revision}`} className="space-y-2 rounded-lg border border-hairline/40 p-3" role="group" aria-label={verifiedAccountLabel(binding.origin)}>
          <p className="break-words text-[13px]">{verifiedAccountLabel(binding.origin)}</p>
          <p className="text-[12px] text-ink-secondary">{state}</p>
          {binding.active && <div className="flex flex-wrap gap-2">
            <button type="button" className={memoryButtonClass} disabled={isBusy} onClick={() => void change({ bindingId: binding.id, expectedRevision: binding.revision, as: "owner" })}>This is my account</button>
            <button type="button" className={memoryButtonClass} disabled={isBusy} onClick={() => void change({ bindingId: binding.id, expectedRevision: binding.revision, as: "person" })}>Separate person</button>
            {choicesForBinding.length > 0 && <div className="flex min-h-10 items-center gap-2 text-[13px]"><label>Same person as<select aria-label={`Existing account for ${verifiedAccountLabel(binding.origin)}`} className="ml-2 min-h-10 rounded-md border border-hairline bg-inset px-2 text-[13px]" value={selectedPersonId} disabled={isBusy} onChange={event => setChoices(previous => ({ ...previous, [binding.id]: event.target.value }))}><option value="">Choose verified account</option>{choicesForBinding.map(choice => <option key={choice.personId} value={choice.personId}>{choice.label}</option>)}</select></label><button type="button" className={memoryButtonClass} disabled={isBusy || !selectedPersonId} onClick={() => void change({ bindingId: binding.id, expectedRevision: binding.revision, as: "person", personId: selectedPersonId })}>Link accounts</button></div>}
            {binding.personId && <button type="button" className={memoryButtonClass} disabled={isBusy} onClick={() => void change({ bindingId: binding.id, expectedRevision: binding.revision, as: "unlink" })}>Unlink</button>}
          </div>}
        </div>;
      })}
    </div>
    {shareRows && shareRows.length > 0 && <div className="space-y-3 border-t border-hairline/40 pt-3">
      <div><h4 className="text-[13px] font-medium">Shared audiences</h4><p className="mt-1 text-[12px] text-ink-secondary">Sharing lets a separate person&apos;s conversations recall memories saved for that room, project, team or workspace. Only those audiences are offered here; the workspace owner&apos;s private conversations are not shared by this choice. Stopping applies to future recall; text already sent to a provider cannot be withdrawn.</p></div>
      {shareRows.map(row => {
        const selectedScopeId = shareChoices[row.personId] ?? "";
        const isBusy = Boolean(busy) || disabled;
        return <div key={row.personId} role="group" aria-label={`Shared audiences for ${row.label}`} className="space-y-2 rounded-lg border border-hairline/40 p-3">
          <p className="break-words text-[13px]">{row.label}</p>
          {row.granted.length ? <ul className="space-y-2">{row.granted.map(audience => <li key={audience.id} className="flex flex-wrap items-center gap-2 text-[13px]"><span className="break-words">{shareAudienceLabel(audience)}</span><button type="button" className={memoryButtonClass} disabled={isBusy} aria-label={`Stop sharing ${shareAudienceLabel(audience)} with ${row.label}`} onClick={() => void share({ personId: row.personId, scopeId: audience.id, granted: false })}>Stop sharing</button></li>)}</ul>
            : <p className="text-[12px] text-ink-secondary">No shared audiences. This person recalls only their own conversations and preferences.</p>}
          {row.available.length > 0 && <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (selectedScopeId) void share({ personId: row.personId, scopeId: selectedScopeId, granted: true }); }}>
            <label className="block space-y-1 text-[13px]">Share an audience<select className={memoryInputClass} value={selectedScopeId} disabled={isBusy} onChange={event => setShareChoices(previous => ({ ...previous, [row.personId]: event.target.value }))}><option value="">Choose an audience</option>{row.available.map(audience => <option key={audience.id} value={audience.id}>{shareAudienceLabel(audience)}</option>)}</select></label>
            <button className={memoryButtonClass} disabled={isBusy || !selectedScopeId}>Share audience</button>
          </form>}
        </div>;
      })}
    </div>}
  </section>;
}

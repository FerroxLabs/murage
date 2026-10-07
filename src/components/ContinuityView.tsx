// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { Switch } from "./SettingsPrimitives";
import {
  BRIEF_KEY,
  CONTINUITY_CHANGED_SENTENCE,
  CONTINUITY_HEADLINE,
  CONTINUITY_NEEDS_MEMORY,
  CONTINUITY_SENTENCE,
  RELATION_KEY,
  byteCounter,
  continuityBytes,
  DISPUTED_SENTENCE,
  PROPOSED_HEADLINE,
  REFLECT_HEADLINE,
  REFLECT_SENTENCE,
  STATUS_HEADLINE,
  WRONG_TEMPLATE_TEXT,
  canRetryReflection,
  coverageLine,
  dailyRunsLine,
  proposalQuoteLine,
  proposalsChip,
  reflectedLine,
  refusalLine,
  rowOriginLine,
  draftIsStale,
  rebaseDraft,
  recordVersion,
  recordsOfKind,
  wroteLine,
  type ContinuityDraft,
  type ContinuityKind,
  type ContinuityRecord,
  type ContinuityView as Data,
  type DisputeView,
  type ProposalView,
  type ReflectionStatus,
} from "@/lib/continuity";

// The Continuity block of a bot's Memory settings (PIP P1). Presentation only:
// ContinuityBlock owns the requests. Kept free of the store so it renders in node.

const INPUT = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";
const BUTTON = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50";
const NOTE = "text-[12px] text-ink-secondary";

export interface ContinuityViewProps {
  on: boolean;
  /** null while memory status is unknown; false when memory mode is not active */
  memoryActive: boolean | null;
  data: Data | null;
  loading?: boolean;
  busy?: boolean;
  error?: string;
  now: number;
  onToggle: (on: boolean) => void;
  onOpenMemory: () => void;
  /** Each resolves true only when the change was saved; text is kept on false. */
  onSave: (kind: ContinuityKind, key: string, expectedVersion: number, text: string, expectedId?: string) => Promise<boolean> | boolean | void;
  onAdd: (kind: "commitment" | "self-trait", text: string) => Promise<boolean> | boolean | void;
  onDelete: (record: ContinuityRecord) => Promise<boolean> | boolean | void;
  /** PIP P2: reflection between conversations. All optional; absent means the block looks as before. */
  reflectOn?: boolean;
  reflectThreads?: Array<{ id: string; title: string }>;
  onReflectExclude?: (threadId: string, excluded: boolean) => Promise<boolean> | boolean | void;
  onReflectToggle?: (on: boolean) => void;
  proposals?: ProposalView[];
  disputes?: DisputeView[];
  status?: ReflectionStatus | null;
  onConfirmProposal?: (proposal: ProposalView) => Promise<boolean> | boolean | void;
  onDismissProposal?: (proposal: ProposalView) => Promise<boolean> | boolean | void;
  onKeep?: (dispute: DisputeView) => Promise<boolean> | boolean | void;
  onRetryReflection?: () => Promise<boolean> | boolean | void;
}

/** Anything but an explicit false counts as saved (a plain callback has no result to report). */
const succeeded = async (work: Promise<boolean> | boolean | void): Promise<boolean> => (await work) !== false;

function Changed({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center gap-3">
    <span className="text-[12px] text-danger">{CONTINUITY_CHANGED_SENTENCE}</span>
    <button type="button" className={BUTTON} onClick={onKeep}>Keep editing</button>
    <button type="button" className={BUTTON} onClick={onDiscard}>Discard my draft</button>
  </div>;
}

function Meta({ record, now }: { record: ContinuityRecord; now: number }) {
  return <span className={NOTE}>{record.tier === "observed" ? rowOriginLine(record, now) : wroteLine(record.editedAt, now)}</span>;
}

/** One textarea bound to one record (brief or relation). */
function SingleEditor({ title, label, kind, keyName, limit, data, now, busy, placeholder, canDelete, onSave, onDelete }: {
  title: string; label: string; kind: ContinuityKind; keyName: string; limit: number; data: Data; now: number; busy?: boolean; placeholder: string; canDelete?: boolean;
  onSave: ContinuityViewProps["onSave"]; onDelete: ContinuityViewProps["onDelete"];
}) {
  const record = recordsOfKind(data.records, kind).find((row) => row.key === keyName) ?? null;
  const [draft, setDraft] = useState<ContinuityDraft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const text = draft?.text ?? record?.text ?? "";
  const over = continuityBytes(text) > limit;
  const dirty = draft !== null && draft.text !== (record?.text ?? "");
  const stale = draftIsStale(draft, record);
  return <div className="space-y-1.5">
    <h4 className="text-[13px] font-medium text-ink">{title}</h4>
    <textarea aria-label={label} className={`${INPUT} min-h-[88px] resize-y`} value={text} placeholder={placeholder} onChange={(event) => setDraft({ text: event.target.value, base: draft?.base ?? recordVersion(record), ...(draft ? (draft.baseId ? { baseId: draft.baseId } : {}) : record ? { baseId: record.id } : {}) })} />
    {stale && draft && <Changed onKeep={() => setDraft(rebaseDraft(draft, record))} onDiscard={() => setDraft(null)} />}
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={BUTTON} disabled={busy || stale || !dirty || over || !text.trim()} onClick={() => {
        if (!draft) return;
        void succeeded(onSave(kind, keyName, draft.base, text.trim(), draft.baseId)).then((ok) => { if (ok) setDraft(null); });
      }}>Save</button>
      <span className={over ? "text-[12px] text-danger" : NOTE}>{byteCounter(text, limit)}</span>
      {record && <Meta record={record} now={now} />}
      {canDelete && record && (confirming ? <>
        <span className="text-[12px] text-ink">Remove this?</span>
        <button type="button" className={BUTTON} disabled={busy} onClick={() => { setConfirming(false); void succeeded(onDelete(record)).then((ok) => { if (ok) setDraft(null); }); }}>Yes, remove</button>
        <button type="button" className={BUTTON} onClick={() => setConfirming(false)}>Keep it</button>
      </> : <button type="button" className="text-[12px] text-ink-secondary underline" onClick={() => setConfirming(true)}>Delete</button>)}
    </div>
  </div>;
}

/** A list of short entries: add, edit in place, delete after a quick confirm. */
function ListEditor({ title, kind, noun, data, now, busy, disputes, onKeep, onSave, onAdd, onDelete }: {
  title: string; kind: "commitment" | "self-trait"; noun: string; data: Data; now: number; busy?: boolean;
  disputes?: DisputeView[]; onKeep?: ContinuityViewProps["onKeep"];
  onSave: ContinuityViewProps["onSave"]; onAdd: ContinuityViewProps["onAdd"]; onDelete: ContinuityViewProps["onDelete"];
}) {
  const rows = recordsOfKind(data.records, kind);
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<(ContinuityDraft & { id: string }) | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const full = rows.length >= data.limits.perKind;
  const addOver = continuityBytes(adding) > data.limits.bytes;
  return <div className="space-y-2">
    <h4 className="text-[13px] font-medium text-ink">{title} <span className={NOTE}>({rows.length} of {data.limits.perKind})</span></h4>
    {rows.length === 0 && <p className={NOTE}>Nothing here yet.</p>}
    <ul className="space-y-2">
      {rows.map((row) => <li key={row.id} className="rounded-lg bg-inset p-2.5">
        {editing?.id === row.id ? <div className="space-y-1.5">
          <textarea aria-label={`Edit ${noun}`} className={`${INPUT} min-h-[64px] resize-y`} value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} />
          {draftIsStale(editing, row) && <Changed onKeep={() => setEditing({ id: row.id, ...rebaseDraft(editing, row) })} onDiscard={() => setEditing(null)} />}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={BUTTON} disabled={busy || draftIsStale(editing, row) || !editing.text.trim() || continuityBytes(editing.text) > data.limits.bytes || editing.text.trim() === row.text} onClick={() => {
              void succeeded(onSave(kind, row.key, editing.base, editing.text.trim(), editing.baseId)).then((ok) => { if (ok) setEditing(null); });
            }}>Save</button>
            <button type="button" className={BUTTON} onClick={() => setEditing(null)}>Cancel</button>
            <span className={NOTE}>{byteCounter(editing.text, data.limits.bytes)}</span>
          </div>
        </div> : <div className="space-y-1">
          <p className="whitespace-pre-wrap text-[14px] text-ink">{row.text}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Meta record={row} now={now} />
            {row.disputed === true && <>
              <span className="text-[12px] text-ink">{DISPUTED_SENTENCE}</span>
              {(() => { const dispute = (disputes ?? []).find((item) => item.targetId === row.id); return dispute && onKeep ? <button type="button" className={BUTTON} disabled={busy} onClick={() => { void succeeded(onKeep(dispute)); }}>Keep it</button> : null; })()}
            </>}
            {confirming === row.id ? <>
              <span className="text-[12px] text-ink">Remove this {noun}?</span>
              <button type="button" className={BUTTON} disabled={busy} onClick={() => { setConfirming(null); void succeeded(onDelete(row)); }}>Yes, remove</button>
              <button type="button" className={BUTTON} onClick={() => setConfirming(null)}>Keep it</button>
            </> : <>
              <button type="button" className="text-[12px] text-ink-secondary underline" onClick={() => setEditing({ id: row.id, text: row.text, base: row.version, baseId: row.id })}>Edit</button>
              <button type="button" className="text-[12px] text-ink-secondary underline" onClick={() => setConfirming(row.id)}>Delete</button>
            </>}
          </div>
        </div>}
      </li>)}
    </ul>
    {kind === "commitment" && !rows.some((row) => row.text === WRONG_TEMPLATE_TEXT) && !full && <div>
      <button type="button" className={BUTTON} disabled={busy} onClick={() => { void succeeded(onAdd(kind, WRONG_TEMPLATE_TEXT)); }}>{WRONG_TEMPLATE_TEXT}</button>
    </div>}
    {full ? <p className={NOTE}>This list is full. Remove one before adding another.</p> : <div className="space-y-1.5">
      <textarea aria-label={`Add a ${noun}`} className={`${INPUT} min-h-[56px] resize-y`} value={adding} placeholder={`Add a ${noun}`} onChange={(event) => setAdding(event.target.value)} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={BUTTON} disabled={busy || !adding.trim() || addOver} onClick={() => { void succeeded(onAdd(kind, adding.trim())).then((ok) => { if (ok) setAdding(""); }); }}>Add</button>
        <span className={addOver ? "text-[12px] text-danger" : NOTE}>{byteCounter(adding, data.limits.bytes)}</span>
      </div>
    </div>}
  </div>;
}

/** Proposed entries from the owner's own words: confirm or dismiss, each in the page. */
function ProposedList({ proposals, busy, onConfirm, onDismiss }: { proposals: ProposalView[]; busy?: boolean; onConfirm: ContinuityViewProps["onConfirmProposal"]; onDismiss: ContinuityViewProps["onDismissProposal"] }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return <div id="continuity-proposed" className="space-y-2">
    <h4 className="text-[13px] font-medium text-ink">{PROPOSED_HEADLINE} <span className={NOTE}>({proposals.length})</span></h4>
    <ul className="space-y-2">
      {proposals.map((proposal) => <li key={proposal.id} className="rounded-lg bg-inset p-2.5 space-y-1">
        <p className="whitespace-pre-wrap text-[14px] text-ink">{proposal.statement}</p>
        {proposal.quotes.map((quote) => <p key={quote.sourceId} className={NOTE}>{proposalQuoteLine(quote.text)}</p>)}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={BUTTON} disabled={busy || !onConfirm} onClick={() => { void succeeded(onConfirm?.(proposal)); }}>Confirm</button>
          {confirming === proposal.id ? <>
            <span className="text-[12px] text-ink">Dismiss this?</span>
            <button type="button" className={BUTTON} disabled={busy} onClick={() => { setConfirming(null); void succeeded(onDismiss?.(proposal)); }}>Yes, dismiss</button>
            <button type="button" className={BUTTON} onClick={() => setConfirming(null)}>Keep it</button>
          </> : <button type="button" className={BUTTON} disabled={busy || !onDismiss} onClick={() => setConfirming(proposal.id)}>Dismiss</button>}
        </div>
      </li>)}
    </ul>
  </div>;
}

function ReflectionStatusBlock({ status, now, busy, onRetry }: { status: ReflectionStatus; now: number; busy?: boolean; onRetry?: ContinuityViewProps["onRetryReflection"] }) {
  const refusals = status.refusals.slice(0, 3);
  return <div className="space-y-1.5" aria-label={STATUS_HEADLINE}>
    <h4 className="text-[13px] font-medium text-ink">{STATUS_HEADLINE}</h4>
    <p className={NOTE}>{status.support.copy ?? reflectedLine(status.lastAppliedAt, now)}</p>
    <p className={NOTE}>{dailyRunsLine(status)}</p>
    {status.unreflected > 0 && <p className={NOTE}>{status.unreflected} {status.unreflected === 1 ? "turn" : "turns"} not reflected yet</p>}
    {status.reportedOverLimit && <p className={NOTE}>The engine reported more output tokens than requested.</p>}
    {refusals.map((item) => <p key={item.runId} className={NOTE}>{refusalLine(item.state, item.reason)}</p>)}
    {canRetryReflection(status) && onRetry && <button type="button" className={BUTTON} disabled={busy} onClick={() => { void succeeded(onRetry()); }}>Try again</button>}
  </div>;
}

export function ContinuityView(props: ContinuityViewProps) {
  const { on, memoryActive, data, error, now, busy } = props;
  const coverage = coverageLine(data?.coverage);
  const proposals = props.proposals ?? [];
  const chip = proposalsChip(proposals.length);
  return <section className="rounded-xl bg-card p-4" aria-label="Continuity">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[15px] font-medium text-ink">{CONTINUITY_HEADLINE}</h3>
        <p className="mt-1 text-[12px] text-ink-secondary">{CONTINUITY_SENTENCE}</p>
        <p className="mt-1 text-[12px] text-ink-secondary">Exporting a bot does not carry its continuity.</p>
      </div>
      <Switch checked={on} aria-label={CONTINUITY_HEADLINE} disabled={busy} onClick={() => props.onToggle(!on)} />
    </div>
    {memoryActive === false && <p role="status" className="mt-2 text-[12px] text-ink">
      {CONTINUITY_NEEDS_MEMORY}. <button type="button" className="underline" onClick={props.onOpenMemory}>Open memory settings</button>
    </p>}
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
    {on && <div className="mt-4 space-y-5">
      {props.loading && !data && <p className={NOTE}>Loading.</p>}
      <div className="space-y-1.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-[13px] font-medium text-ink">{REFLECT_HEADLINE}</h4>
            <p className={NOTE}>{REFLECT_SENTENCE}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {chip && <a href="#continuity-proposed" className="rounded-full bg-control px-2.5 py-0.5 text-[12px] text-ink">{chip}</a>}
            <Switch checked={props.reflectOn === true} aria-label={REFLECT_HEADLINE} disabled={busy || !props.onReflectToggle} onClick={() => props.onReflectToggle?.(props.reflectOn !== true)} />
          </div>
        </div>
      </div>
      {proposals.length > 0 && <ProposedList proposals={proposals} busy={busy} onConfirm={props.onConfirmProposal} onDismiss={props.onDismissProposal} />}
      {Boolean(props.reflectThreads?.length) && props.onReflectExclude && <div className="space-y-1.5" aria-label="Conversations for reflection">
        <p className={NOTE}>Choose which conversations this bot can reflect on.</p>
        {props.reflectThreads?.map(thread => <label key={thread.id} className="flex items-center gap-2 text-[12px] text-ink">
          <input type="checkbox" disabled={busy} checked={!props.status?.excludedThreads?.includes(thread.id)} onChange={event => { void props.onReflectExclude?.(thread.id, !event.target.checked); }} />{thread.title}
        </label>)}
      </div>}
      {props.status && <ReflectionStatusBlock status={props.status} now={now} busy={busy} onRetry={props.onRetryReflection} />}
      {data && <>
        <SingleEditor title="Short summary" label="Continuity summary" kind="continuity-brief" keyName={BRIEF_KEY} limit={data.limits.briefBytes} data={data} now={now} busy={busy} placeholder="Who this bot is to you, in a few lines" onSave={props.onSave} onDelete={props.onDelete} />
        <SingleEditor title="How we work together" label="How we work together" kind="relation" keyName={RELATION_KEY} limit={data.limits.bytes} data={data} now={now} busy={busy} placeholder="How you like to work with this bot" canDelete onSave={props.onSave} onDelete={props.onDelete} />
        <ListEditor title="Commitments" kind="commitment" noun="commitment" data={data} now={now} busy={busy} disputes={props.disputes} onKeep={props.onKeep} onSave={props.onSave} onAdd={props.onAdd} onDelete={props.onDelete} />
        <ListEditor title="About this bot" kind="self-trait" noun="trait" data={data} now={now} busy={busy} disputes={props.disputes} onKeep={props.onKeep} onSave={props.onSave} onAdd={props.onAdd} onDelete={props.onDelete} />
        {coverage && <p className={NOTE}>{coverage}</p>}
      </>}
    </div>}
  </section>;
}

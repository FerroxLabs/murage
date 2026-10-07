// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useRef, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { ContinuityView } from "./ContinuityView";
import {
  continuityDeleteBody,
  continuityOptionsPatchBody,
  continuityErrorCode,
  continuityErrorSentence,
  continuityReadBody,
  continuityWriteBody,
  freshKey,
  keepBody,
  loadContinuity,
  pipRefusalSentence,
  proposalConfirmBody,
  proposalDismissBody,
  proposalsReadBody,
  reflectRetryBody,
  reflectExcludeBody,
  reflectStatusBody,
  type DisputeView,
  type ProposalView,
  type ReflectionStatus,
  type ContinuityKind,
  type ContinuityRecord,
  type ContinuityView as Data,
} from "@/lib/continuity";

const act = (body: object) => api("/api/memory/action", { method: "POST", body: JSON.stringify(body) });

/** Bot settings > Memory > Continuity (PIP P1). Owner-written, off by default. */
export function ContinuityBlock({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const on = bot.continuity === true;
  const [data, setData] = useState<Data | null>(null);
  const [memoryActive, setMemoryActive] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [disputes, setDisputes] = useState<DisputeView[]>([]);
  const [status, setStatus] = useState<ReflectionStatus | null>(null);
  const reflectOn = (bot as { continuityOptions?: { reflect?: boolean } | null }).continuityOptions?.reflect === true;
  const retired = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const load = useCallback((isCurrent: () => boolean = () => mounted.current) => loadContinuity(
    () => act(continuityReadBody(bot.id)) as Promise<Partial<Data>>,
    isCurrent,
    { start: () => setLoading(true), data: setData, error: setError, end: () => setLoading(false) },
  ), [bot.id]);

  useEffect(() => {
    let current = true;
    void (api("/api/memory/status") as Promise<{ mode?: string }>).then((status) => { if (current) setMemoryActive(status.mode === "active"); }).catch(() => { if (current) setMemoryActive(null); });
    return () => { current = false; };
  }, [bot.id]);
  /** Proposals and status are secondary: a failed read leaves the rest of the block alone. */
  const loadReflection = useCallback(async (isCurrent: () => boolean = () => mounted.current) => {
    try {
      const [p, st] = await Promise.all([
        act(proposalsReadBody(bot.id)) as Promise<{ proposals?: ProposalView[]; counters?: DisputeView[] }>,
        act(reflectStatusBody(bot.id)) as Promise<ReflectionStatus>,
      ]);
      if (!isCurrent()) return;
      setProposals(p.proposals ?? []);
      setDisputes(p.counters ?? []);
      setStatus(st ?? null);
    } catch { /* leave what is shown */ }
  }, [bot.id]);

  useEffect(() => {
    setData(null);
    setError("");
    if (!on) return undefined;
    let cancelled = false;
    void load(() => !cancelled);
    void loadReflection(() => !cancelled);
    return () => { cancelled = true; };
  }, [on, load, loadReflection]);

  /** Resolves true only when the work succeeded; the view clears a draft on true alone. */
  const run = async (work: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError("");
    let ok = false;
    try { await work(); ok = true; } catch (cause) {
      if (!mounted.current) return false;
      setError(continuityErrorSentence(cause));
      if (continuityErrorCode(cause) === "MEMORY_VERSION_CONFLICT" || continuityErrorCode(cause) === "MEMORY_NOT_FOUND") await load();
    } finally { if (mounted.current) setBusy(false); }
    if (mounted.current && ok) { await load(); await loadReflection(); }
    return ok;
  };

  /** A refused result is a sentence on screen, never a thrown error; the lists reload either way. */
  const guarded = async (call: () => Promise<{ ok?: boolean; reason?: string }>): Promise<boolean> => {
    setBusy(true);
    setError("");
    let ok = false;
    try {
      const result = await call();
      ok = result.ok !== false;
      if (!ok && mounted.current) setError(pipRefusalSentence(result.reason));
    } catch (cause) {
      if (mounted.current) setError(continuityErrorSentence(cause));
    } finally { if (mounted.current) setBusy(false); }
    if (mounted.current) { await load(); await loadReflection(); }
    return ok;
  };

  const confirmProposal = (proposal: ProposalView) => guarded(() => act(proposalConfirmBody(bot.id, proposal.id, proposal.version)) as Promise<{ ok?: boolean; reason?: string }>);
  const dismissProposal = (proposal: ProposalView) => guarded(async () => { await act(proposalDismissBody(bot.id, proposal.id, proposal.version)); return { ok: true }; });
  const keep = (dispute: DisputeView) => guarded(() => act(keepBody(bot.id, dispute.targetId, dispute.generation, dispute.counterVersion)) as Promise<{ ok?: boolean; reason?: string }>);
  const retryReflection = () => guarded(() => act(reflectRetryBody(bot.id)) as Promise<{ ok?: boolean; reason?: string }>);

  const save = (kind: ContinuityKind, key: string, expectedVersion: number, text: string, expectedId?: string) =>
    run(async () => { await act(continuityWriteBody({ botId: bot.id, kind, key, expectedVersion, ...(expectedId ? { expectedId } : {}), text })); });

  const add = (kind: "commitment" | "self-trait", text: string) => run(async () => {
    const taken = new Set([...(data?.records ?? []).filter((row) => row.kind === kind).map((row) => row.key), ...retired.current]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const key = freshKey(text, taken);
      try { await act(continuityWriteBody({ botId: bot.id, kind, key, expectedVersion: 0, text })); return; } catch (cause) {
        const code = continuityErrorCode(cause);
        if (code !== "MEMORY_RECORD_UNAVAILABLE" && code !== "MEMORY_VERSION_CONFLICT") throw cause;
        taken.add(key);
        retired.current.add(key);
      }
    }
    throw new Error("MEMORY_IDENTITY_PIP_KEY_INVALID");
  });

  const remove = (record: ContinuityRecord) => run(async () => {
    await act(continuityDeleteBody({ botId: bot.id, kind: record.kind as ContinuityKind, key: record.key, expectedVersion: record.version, expectedId: record.id }));
    retired.current.add(record.key);
  });

  return <ContinuityView
    on={on}
    memoryActive={memoryActive}
    data={data}
    loading={loading}
    busy={busy}
    error={error}
    now={Date.now()}
    onToggle={(next) => dispatch({ type: "updateBot", botId: bot.id, patch: { continuity: next } })}
    onOpenMemory={() => dispatch({ type: "toggleAppSettings", open: true, section: "memory" })}
    reflectOn={reflectOn}
    onReflectToggle={(next) => dispatch({ type: "updateBot", botId: bot.id, patch: continuityOptionsPatchBody(next) as never })}
    proposals={proposals}
    disputes={disputes}
    status={status}
    onConfirmProposal={confirmProposal}
    onDismissProposal={dismissProposal}
    onKeep={keep}
    onRetryReflection={retryReflection}
    reflectThreads={[{ id: bot.threadId, title: "Main conversation" }, ...(bot.tasks ?? []).map(t => ({ id: t.threadId, title: t.title || "Conversation" }))]}
    onReflectExclude={(threadId, excluded) => guarded(() => act(reflectExcludeBody(bot.id, threadId, excluded)) as Promise<{ ok?: boolean }>)}
    onSave={save}
    onAdd={add}
    onDelete={remove}
  />;
}

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from OpenMausBot 95a94daa (#1840, Apache-2.0). Offered under a
// failed turn whose Claude Code is too old for the model: Murage runs Claude
// Code's own updater, or the person copies the command and runs it. Retry
// follows either path, because the update alone does not resend the message.
// Loaded on first use.
import { Check, Copy, Download, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";

import { claudeUpdateCommand } from "@/lib/claude-update";
import { api, useStore, type InstanceInfo } from "@/state/store";


type Phase = { kind: "ask" } | { kind: "updating" } | { kind: "updated"; version: string } | { kind: "manual" } | { kind: "failed"; error: string };

const pill = "flex min-h-9 items-center gap-1.5 rounded-full border border-hairline/40 px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink";

export default function ClaudeUpdatePrompt({ instance, onRetry }: { instance: InstanceInfo; onRetry?: () => void }) {
  // The engine's own executable, the one the update route runs (audit, Kimi 5).
  const updateCommand = claudeUpdateCommand(instance.cli);
  const { dispatch } = useStore();
  const [phase, setPhase] = useState<Phase>({ kind: "ask" });
  const [copied, setCopied] = useState(false);

  const update = () => {
    if (phase.kind === "updating") return;
    setPhase({ kind: "updating" });
    void (async () => {
      try {
        const { version } = (await api(`/api/instances/${encodeURIComponent(instance.instanceId)}/claude-update`, { method: "POST", body: "{}" })) as { version: string };
        setPhase({ kind: "updated", version });
        try {
          const { instances } = (await api("/api/instances")) as { instances: InstanceInfo[] };
          dispatch({ type: "instances", instances });
        } catch { /* the Engines list refreshes on its own later */ }
      } catch (error) {
        setPhase({ kind: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };

  const retry = onRetry && <button type="button" onClick={onRetry} className={pill}><RefreshCw size={12} aria-hidden="true" /> Retry</button>;

  return (
    <div className="mt-3 text-[13px] text-ink" role="group" aria-label="Update Claude Code">
      {phase.kind === "ask" && (
        <>
          <p className="leading-relaxed">This model needs a newer Claude Code. Murage can update it for you.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={update} className="flex min-h-9 items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-[12.5px] font-medium text-white hover:brightness-110">
              <Download size={12} aria-hidden="true" /> Update Claude for me
            </button>
            <button type="button" onClick={() => setPhase({ kind: "manual" })} className={pill}>I'll do it myself</button>
          </div>
        </>
      )}
      {phase.kind === "updating" && (
        <p className="flex items-center gap-2 text-ink-secondary" aria-live="polite"><Loader2 size={13} className="animate-spin" aria-hidden="true" /> Updating Claude Code. This can take a minute.</p>
      )}
      {phase.kind === "updated" && (
        <>
          <p className="flex items-center gap-1.5" aria-live="polite"><Check size={13} aria-hidden="true" /> Claude Code is now {phase.version}.</p>
          {retry && <div className="mt-2">{retry}</div>}
        </>
      )}
      {(phase.kind === "manual" || phase.kind === "failed") && (
        <>
          {phase.kind === "failed" && <p className="mb-1.5 break-words text-danger">{phase.error}</p>}
          <p className="leading-relaxed text-ink-secondary">Run this in Terminal, then retry:</p>
          <div className="mt-1.5 flex items-center gap-1 rounded-md bg-inset px-2 py-1 font-mono text-[12px]">
            <span className="flex-1 select-all">{updateCommand}</span>
            <button type="button" aria-label="Copy command" title="Copy command" className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
              onClick={() => { void navigator.clipboard?.writeText(updateCommand); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {retry}
            {phase.kind === "failed" && <button type="button" onClick={update} className={pill}>Try updating again</button>}
          </div>
        </>
      )}
    </div>
  );
}

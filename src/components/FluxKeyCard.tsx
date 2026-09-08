// The one place a Flux Router key is entered. Everything else that mentions
// Flux points here; there is deliberately no second key field anywhere.
//
// Write-only, like every other credential row in this app: the value goes out
// on `PUT /api/config` and never comes back. GET /api/config answers
// `flux: { configured: boolean }` (server/index.ts) and `ConfigStatus.flux` is
// typed to match (state/store.tsx), so the renderer has no field a saved key
// could arrive in. The dot and the word "Connected" are the whole of what this
// component knows about a key that already exists.
//
// WHY THE CONFIG ROUTE AND NOT `window.muragebox.setCredential`.
// The other workspace secrets are handed to the desktop shell, which puts them
// in the OS-encrypted store. Flux is not in that table yet: neither
// WORKSPACE_CREDENTIALS (electron/workspace-credentials.mjs) nor CREDENTIAL_PATCH
// (electron/main.mjs) lists a flux row, and the preload's `setCredential` type
// (src/types/muragebox.d.ts) has no name for one, so the IPC would reject it.
// `PUT /api/config` is the door that works today on both surfaces, and it is
// the same fallback ApiKeyRow already uses outside the packaged app. When the
// shell grows a flux row, this should move onto it.
import { useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import { FLUX_COPY, fluxKeyPatch, fluxKeyPlaceholder } from "@/lib/flux-invite";

export interface FluxKeyCardBodyProps {
  /** A key is saved. Presence only; the key itself is never here. */
  configured: boolean;
  /** What is currently typed. Empty after every successful save. */
  value: string;
  onValue: (next: string) => void;
  onSave: () => void;
  saving: boolean;
  error: string | null;
}

/** Rendering only, so every state has a test that does not need a server. */
export function FluxKeyCardBody({
  configured,
  value,
  onValue,
  onSave,
  saving,
  error,
}: FluxKeyCardBodyProps) {
  // Empty box while a key is saved means "remove it", the same gesture the
  // other credential rows use.
  const clearing = !value.trim() && configured;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-ink-secondary">
        <span className={cn("size-1.5 rounded-full", configured ? "bg-success" : "bg-raised-hover")} />
        <span>{FLUX_COPY.keyLabel}</span>
        <span className="rounded bg-control px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-secondary">
          Optional
        </span>
        {configured && <span className="text-[11px] text-success">{FLUX_COPY.connected}</span>}
      </div>
      <div className="mb-1.5 text-[12px] leading-relaxed text-ink-secondary">{FLUX_COPY.keyHelp}</div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => onValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSave()}
          placeholder={fluxKeyPlaceholder(configured)}
          aria-label={FLUX_COPY.keyLabel}
          autoComplete="off"
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          type="button"
          onClick={onSave}
          disabled={saving || (!value.trim() && !configured)}
          className={cn(
            "flex w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-lg py-2 text-[13px]",
            clearing ? "bg-control text-danger hover:bg-raised-hover" : "bg-control text-ink hover:bg-raised-hover",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
          title={clearing ? "Remove the saved key" : "Save"}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : clearing ? "Clear" : <><Check size={13} />Save</>}
        </button>
      </div>
      <a
        href={FLUX_COPY.keyHref}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-accent hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      >
        {FLUX_COPY.keyLinkLabel}
        <ExternalLink size={12} aria-hidden="true" />
      </a>
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

/** The live card. Reads presence from config and writes through the harness. */
export function FluxKeyCard({ onSaved }: { onSaved?: () => void | Promise<void> } = {}) {
  const { state, dispatch } = useStore();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = state.config?.flux?.configured ?? false;

  const save = () => {
    if (saving || (!value.trim() && !configured)) return;
    setSaving(true);
    setError(null);
    api("/api/config", { method: "PUT", body: fluxKeyPatch(value.trim()) })
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        // The typed key leaves the renderer the moment it is saved. Nothing
        // keeps a copy: config answers with a boolean, not the value.
        setValue("");
        void onSaved?.();
      })
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <FluxKeyCardBody
      configured={configured}
      value={value}
      onValue={setValue}
      onSave={save}
      saving={saving}
      error={error}
    />
  );
}

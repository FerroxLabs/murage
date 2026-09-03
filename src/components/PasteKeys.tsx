// Paste a whole .env, a password-manager note or a chat message; Murage says
// which keys it recognised and asks about each one separately.
//
// Same security model as ApiKeys.tsx, which this deliberately does not
// duplicate: the packaged Electron app saves through the OS-backed store, and
// browser development falls back to PUT /api/config. Secrets are write-only
// either way — GET /api/config returns configured flags, never values. The
// per-provider save table lives in shared/key-extract.ts because this surface
// touches eight sections and ApiKeys.tsx's SECTIONS table covers three; that
// file's test asserts the three overlapping rows still agree, so the two
// cannot drift apart quietly.
//
// THE PASTED BLOB IS NEVER REACT STATE. The textarea is uncontrolled and read
// once, through a ref, when Scan is pressed — then cleared. That is not a
// style choice: anything in state is in the render tree, and a render tree
// full of somebody's keys is the exact leak this feature must not be. The
// consequence is that `PasteKeysBody` has no `blob` prop at all, so no test,
// snapshot or error boundary can put one on screen.
//
// NOTHING IS SAVED BY SCANNING. Extraction produces suggestions. Each row is
// confirmed on its own, one key at a time, and a row whose provider is
// ambiguous cannot be confirmed until the person says which provider it is.
import { useRef, useState } from "react";
import { Check, Loader2, TriangleAlert, X } from "lucide-react";

import { api, useStore, type ConfigStatus } from "@/state/store";
import { cn } from "@/lib/cn";
import {
  extractKeys,
  maskKey,
  providerConfigured,
  PROVIDERS,
  type ConfiguredFlags,
  type KeyCandidate,
  type ProviderId,
} from "../../shared/key-extract";

export type RowStatus = "pending" | "saving" | "saved" | "dismissed";

export interface PasteRow {
  /** The suggestion. `candidate.value` is blanked once the row is finished. */
  candidate: KeyCandidate;
  /** Which destination the person picked, when more than one was offered. */
  chosen: ProviderId | null;
  status: RowStatus;
  error: string | null;
}

/** The one destination this row would write to, or null while it is still a
 * question. A single-provider candidate answers itself; anything else waits. */
export function rowTarget(row: PasteRow): ProviderId | null {
  if (row.candidate.providers.length === 1) return row.candidate.providers[0]!;
  return row.chosen;
}

export interface PasteKeysBodyProps {
  rows: PasteRow[];
  /** A scan has been run at least once, so "nothing found" can be said. */
  scanned: boolean;
  /** Receives the raw blob exactly once. The caller must not keep it. */
  onScan: (blob: string) => void;
  onChoose: (index: number, provider: ProviderId) => void;
  onAccept: (index: number) => void;
  onDismiss: (index: number) => void;
  /** Presence flags from GET /api/config. Null until it has answered. */
  configured: ConfiguredFlags | null;
}

const HELP =
  "Paste anything that has keys in it. Murage reads it here on this computer, shows you what it found, and saves nothing until you say so.";

/** Rendering only, so every state has a test that does not need a server. */
export function PasteKeysBody({
  rows,
  scanned,
  onScan,
  onChoose,
  onAccept,
  onDismiss,
  configured,
}: PasteKeysBodyProps) {
  const box = useRef<HTMLTextAreaElement>(null);

  const scan = () => {
    const el = box.current;
    if (!el) return;
    const blob = el.value;
    // Cleared immediately, found or not. Everything worth keeping is already
    // in `rows`, and what is left is a screenful of somebody's secrets.
    el.value = "";
    onScan(blob);
  };

  const live = rows.filter((row) => row.status !== "dismissed");

  return (
    <div>
      <div className="mb-1.5 text-[13px] text-ink-secondary">Paste several keys at once</div>
      <div className="mb-1.5 text-[12px] leading-relaxed text-ink-secondary">{HELP}</div>
      <textarea
        ref={box}
        rows={4}
        defaultValue=""
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={"OPENAI_API_KEY=…\nFLUX_API_KEY=…"}
        aria-label="Paste keys to look through"
        className="w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={scan}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
        >
          Look for keys
        </button>
        {scanned && live.length === 0 && (
          <span className="text-[12px] text-ink-secondary">
            Nothing recognised. Murage only picks up keys it is sure of, so paste the line the key is on.
          </span>
        )}
        {live.length > 0 && (
          <span className="text-[12px] text-ink-secondary">
            {live.length === 1 ? "1 key found" : `${live.length} keys found`}. Confirm each one.
          </span>
        )}
      </div>

      {live.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {rows.map((row, index) =>
            row.status === "dismissed" ? null : (
              <li
                key={index}
                className="rounded-lg border border-hairline/40 bg-inset px-3 py-2.5"
                data-testid="paste-key-row"
              >
                <PasteKeyRow
                  row={row}
                  configured={configured}
                  onChoose={(provider) => onChoose(index, provider)}
                  onAccept={() => onAccept(index)}
                  onDismiss={() => onDismiss(index)}
                />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function PasteKeyRow({
  row,
  configured,
  onChoose,
  onAccept,
  onDismiss,
}: {
  row: PasteRow;
  configured: ConfiguredFlags | null;
  onChoose: (provider: ProviderId) => void;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const { candidate } = row;
  const target = rowTarget(row);
  const ambiguous = candidate.providers.length > 1;
  const unstorable = candidate.providers.length === 0;
  // The ONLY thing derived from the key that reaches the screen.
  const masked = maskKey(candidate.value);

  const heading = unstorable
    ? (candidate.unsupported?.label ?? "Unrecognised key")
    : target
      ? PROVIDERS[target].label
      : "Which key is this?";

  const alreadySaved = target ? providerConfigured(target, configured) : false;

  return (
    <div>
      <div className="flex items-center gap-2 text-[13px]">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            row.status === "saved" ? "bg-success" : unstorable ? "bg-warning" : "bg-raised-hover",
          )}
        />
        <span className="text-ink">{heading}</span>
        <span className="font-mono text-[12px] text-ink-secondary" data-testid="paste-key-hint">
          {masked}
        </span>
        {candidate.name && (
          <span className="rounded bg-control px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">
            {candidate.name}
          </span>
        )}
        {alreadySaved && row.status !== "saved" && (
          <span className="text-[11px] text-success">Already connected</span>
        )}
        {row.status === "saved" && <span className="text-[11px] text-success">Saved</span>}
      </div>

      {unstorable ? (
        <div className="mt-1.5 flex gap-1.5 rounded-lg border border-warning/25 bg-warning/10 px-2 py-1.5 text-[11px] leading-[1.4] text-warning">
          <TriangleAlert size={13} className="mt-px shrink-0" aria-hidden="true" />
          <span>{candidate.unsupported?.reason ?? "Murage has nowhere to keep this."}</span>
        </div>
      ) : (
        <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {ambiguous && !target
            ? "This prefix is used by more than one service, so Murage will not guess. Pick where it goes."
            : target
              ? PROVIDERS[target].blurb
              : ""}
          {alreadySaved && row.status !== "saved" && " Saving replaces the key already there."}
        </div>
      )}

      {ambiguous && row.status !== "saved" && (
        <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Which key is this?">
          {candidate.providers.map((provider) => (
            <button
              key={provider}
              type="button"
              aria-pressed={row.chosen === provider}
              onClick={() => onChoose(provider)}
              className={cn(
                "rounded-lg border px-2 py-1 text-[12px]",
                row.chosen === provider
                  ? "border-accent/70 bg-control text-ink"
                  : "border-hairline/40 text-ink-secondary hover:bg-control",
              )}
            >
              {PROVIDERS[provider].label}
            </button>
          ))}
        </div>
      )}

      {row.status !== "saved" && (
        <div className="mt-2 flex gap-2">
          {!unstorable && (
            <button
              type="button"
              onClick={onAccept}
              // A row with an open question cannot be confirmed. This is the
              // whole no-guessing rule, expressed as a disabled button.
              disabled={target === null || row.status === "saving"}
              className="flex w-[92px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
              title={target === null ? "Pick which key this is first" : "Save this key"}
            >
              {row.status === "saving" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <>
                  <Check size={12} />
                  {alreadySaved ? "Replace" : "Save"}
                </>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            disabled={row.status === "saving"}
            className="flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-ink-secondary hover:bg-control disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size={12} />
            Ignore
          </button>
        </div>
      )}

      {row.error && <div className="mt-1 text-[12px] text-danger">{row.error}</div>}
    </div>
  );
}

/** Blank the secret out of a finished row. The hint and the label survive
 * because they are what the person reads; the key does not, because the
 * renderer has no further use for it. */
function spent(row: PasteRow, status: RowStatus, error: string | null): PasteRow {
  return { ...row, status, error, candidate: { ...row.candidate, value: "" } };
}

/** The live surface. Reads presence from config and writes through the same
 * two doors ApiKeys.tsx uses. */
export function PasteKeys() {
  const { state, dispatch } = useStore();
  const [rows, setRows] = useState<PasteRow[]>([]);
  const [scanned, setScanned] = useState(false);

  const patch = (index: number, next: (row: PasteRow) => PasteRow) =>
    setRows((current) => current.map((row, i) => (i === index ? next(row) : row)));

  const onScan = (blob: string) => {
    setScanned(true);
    // Rows already dealt with stay dealt with; a re-scan must not resurrect a
    // key the person just said no to.
    setRows((current) => {
      const finished = current.filter((row) => row.status !== "pending");
      const seen = new Set(current.map((row) => row.candidate.value).filter(Boolean));
      const fresh = extractKeys(blob)
        .filter((candidate) => !seen.has(candidate.value))
        .map<PasteRow>((candidate) => ({ candidate, chosen: null, status: "pending", error: null }));
      return [...finished, ...fresh];
    });
  };

  const onAccept = (index: number) => {
    const row = rows[index];
    if (!row || row.status !== "pending") return;
    const target = rowTarget(row);
    if (!target) return;
    const value = row.candidate.value.trim();
    if (!value) return;

    patch(index, (current) => ({ ...current, status: "saving", error: null }));
    const provider = PROVIDERS[target];
    const request =
      provider.credential && window.muragebox?.setCredential
        ? window.muragebox.setCredential(provider.credential, value)
        : api("/api/config", { method: "PUT", body: JSON.stringify(provider.body(value)) });

    request
      .then((status: ConfigStatus) => {
        dispatch({ type: "configStatus", config: status });
        patch(index, (current) => spent(current, "saved", null));
      })
      .catch((e: Error) => patch(index, (current) => ({ ...current, status: "pending", error: e.message })));
  };

  return (
    <PasteKeysBody
      rows={rows}
      scanned={scanned}
      onScan={onScan}
      onChoose={(index, provider) => patch(index, (current) => ({ ...current, chosen: provider }))}
      onAccept={onAccept}
      onDismiss={(index) => patch(index, (current) => spent(current, "dismissed", null))}
      configured={state.config ?? null}
    />
  );
}

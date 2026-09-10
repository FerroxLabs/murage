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
// NO KEY IS EVER REACT STATE, AND THE PASTED BLOB LEAST OF ALL. The textarea
// is uncontrolled and read once, through a ref, when Scan is pressed — then
// cleared; `PasteKeysBody` has no `blob` prop at all. The extracted keys get
// the same treatment, which is the harder half: `extractKeys` hands back the
// plaintext, and that plaintext goes into a vault held in a ref (see
// `createKeyVault`), never into `setRows`. A `PasteRow` carries an id, a
// label, a name and `maskKey`'s four characters — there is no field on it a
// key could sit in.
//
// That is not a style choice: anything in state is in props, and props are in
// React DevTools, in a prop-serialising snapshot, and in an error boundary's
// dump. A render tree full of somebody's keys is the exact leak this feature
// must not be, so no test, snapshot or error boundary can put one on screen —
// and the tests assert that against the row objects themselves, not only
// against the HTML.
//
// NOTHING IS SAVED BY SCANNING. Extraction produces suggestions. Each row is
// confirmed on its own, one key at a time, and a row whose provider is
// ambiguous cannot be confirmed until the person says which provider it is.
import { useEffect, useRef, useState } from "react";
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
  type UnsupportedRow,
} from "../../shared/key-extract";

export type RowStatus = "pending" | "saving" | "saved" | "dismissed";

/** One suggestion, as React and the renderer see it.
 *
 * THERE IS NO KEY IN HERE. `mask` is `maskKey`'s output — four characters,
 * computed once at extraction from a value this object never holds — and the
 * plaintext it came from is in the vault, addressed by `id`. Every field below
 * is safe to render, serialise, log and hand to an error boundary. */
export interface PasteRow {
  /** Stable for the life of the row, and the only way to address it. Positions
   * move when a second paste arrives; ids do not. */
  id: string;
  /** The left-hand side the key was found under, if any. Names are not
   * secret; this is the one word that tells two rows apart on screen. */
  name?: string;
  /** `••••` plus the last four characters, or `••••` alone for a key too short
   * to hint at. The ONLY thing derived from the key that exists out here. */
  mask: string;
  /** Where this could go. 1 = certain. >1 = the person must choose.
   *  0 = recognised but unstorable; see `unsupported`. */
  providers: readonly ProviderId[];
  /** Set when `providers` is empty and we know what the thing is. */
  unsupported?: UnsupportedRow;
  /** Which destination the person picked, when more than one was offered. */
  chosen: ProviderId | null;
  status: RowStatus;
  error: string | null;
}

/** Turn one extracted candidate into a row. This is the boundary the secret
 * does not cross: the value goes in, the mask comes out. */
export function toPasteRow(id: string, candidate: KeyCandidate): PasteRow {
  return {
    id,
    ...(candidate.name === undefined ? {} : { name: candidate.name }),
    mask: maskKey(candidate.value),
    providers: candidate.providers,
    ...(candidate.unsupported === undefined ? {} : { unsupported: candidate.unsupported }),
    chosen: null,
    status: "pending",
    error: null,
  };
}

/** The one destination this row would write to, or null while it is still a
 * question. A single-provider candidate answers itself; anything else waits. */
export function rowTarget(row: PasteRow): ProviderId | null {
  if (row.providers.length === 1) return row.providers[0]!;
  return row.chosen;
}

export interface PasteKeysBodyProps {
  rows: PasteRow[];
  /** A scan has been run at least once, so "nothing found" can be said. */
  scanned: boolean;
  /** Receives the raw blob exactly once. The caller must not keep it. */
  onScan: (blob: string) => void;
  onChoose: (id: string, provider: ProviderId) => void;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
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
        placeholder={"OPENAI_API_KEY=…\nCOMPOSIO_API_KEY=…"}
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
          {rows.map((row) =>
            row.status === "dismissed" ? null : (
              <li
                key={row.id}
                className="rounded-lg border border-hairline/40 bg-inset px-3 py-2.5"
                data-testid="paste-key-row"
              >
                <PasteKeyRow
                  row={row}
                  configured={configured}
                  onChoose={(provider) => onChoose(row.id, provider)}
                  onAccept={() => onAccept(row.id)}
                  onDismiss={() => onDismiss(row.id)}
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
  const target = rowTarget(row);
  const ambiguous = row.providers.length > 1;
  const unstorable = row.providers.length === 0;
  // Already masked, by `toPasteRow`, from a value this component never had.
  const masked = row.mask;

  const heading = unstorable
    ? (row.unsupported?.label ?? "Unrecognised key")
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
        {row.name && (
          <span className="rounded bg-control px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">
            {row.name}
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
          <span>{row.unsupported?.reason ?? "Murage has nowhere to keep this."}</span>
        </div>
      ) : (
        <div className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
          {target === "flux"
            ? "Manage Flux Router in Models. Opening Models clears this pasted copy; enter your key in the Flux Router card to connect."
            : ambiguous && !target
            ? "This prefix is used by more than one service, so Murage will not guess. Pick where it goes."
            : target
              ? PROVIDERS[target].blurb
              : ""}
          {target !== "flux" && alreadySaved && row.status !== "saved" && " Saving replaces the key already there."}
        </div>
      )}

      {ambiguous && row.status !== "saved" && (
        <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="Which key is this?">
          {row.providers.map((provider) => (
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
              className="flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              title={target === null ? "Pick which key this is first" : target === "flux" ? "Open the single Flux Router key editor" : "Save this key"}
            >
              {row.status === "saving" ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <>
                  {target !== "flux" && <Check size={12} />}
                  {target === "flux" ? "Open Flux Router in Models" : alreadySaved ? "Replace" : "Save"}
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

/** Where the plaintext lives: outside React, for exactly as long as the person
 * has not finished deciding about it.
 *
 * `admit` is also the dedupe: it remembers a short non-reversible tag for every
 * value it has ever been shown, so a key that has been offered once is never
 * offered again — not after it is dismissed, not after it is saved, and not
 * after `forget` has thrown the value away. The tag, not the value, is what
 * survives, which is why "no" keeps meaning no. Nothing in here is state, a
 * prop, rendered, persisted or sent anywhere. */
export interface KeyVault {
  /** A row id for a value never seen before, or null for one already offered. */
  admit: (value: string) => string | null;
  /** The plaintext for a row, or "" once it has been forgotten. */
  read: (id: string) => string;
  /** Throw the plaintext away. The row keeps its mask and its verdict. */
  forget: (id: string) => void;
  /** How many plaintext values are still held. */
  size: () => number;
}

/** A short tag for a value, used only to compare it with other values this
 * session. Two 32-bit FNV-1a passes with different seeds, so a collision
 * between two of the handful of keys in one paste is not a thing that happens.
 * It is a dedupe token, not a security boundary — it is never rendered, never
 * written down and never leaves this module. */
function fingerprint(value: string): string {
  const pass = (seed: number) => {
    let h = seed;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  };
  return `${pass(0x811c9dc5)}.${pass(0x9e3779b9)}.${value.length}`;
}

export function createKeyVault(): KeyVault {
  const values = new Map<string, string>();
  const offered = new Set<string>();
  let minted = 0;
  return {
    admit(value) {
      const tag = fingerprint(value);
      if (offered.has(tag)) return null;
      offered.add(tag);
      const id = `row-${++minted}`;
      values.set(id, value);
      return id;
    },
    read: (id) => values.get(id) ?? "",
    forget: (id) => {
      values.delete(id);
    },
    size: () => values.size,
  };
}

/** Everything this surface does that is not drawing: what a scan adds, what a
 * confirmation writes, and which row a finished write belongs to. Lives out
 * here rather than inside the component because the interesting cases are
 * sequences — a save that lands after a second paste — and a sequence needs a
 * handle to drive it. */
export interface PasteEffects {
  /** Hand the new row list to React. */
  render: (rows: PasteRow[]) => void;
  /** Write one key. Rejects with the message the person should read. */
  save: (target: ProviderId, value: string) => Promise<ConfigStatus>;
  /** A write landed, so the app's configured flags moved. */
  saved: (status: ConfigStatus) => void;
}

export interface PasteController {
  rows: () => PasteRow[];
  /** How many plaintext key values this surface is still holding. */
  held: () => number;
  scan: (blob: string) => void;
  choose: (id: string, provider: ProviderId) => void;
  accept: (id: string) => Promise<void>;
  dismiss: (id: string) => void;
}

export function createPasteController(effects: PasteEffects): PasteController {
  const vault = createKeyVault();
  let rows: PasteRow[] = [];

  const put = (next: PasteRow[]) => {
    rows = next;
    effects.render(rows);
  };
  // BY ID, NEVER BY POSITION. A save is asynchronous, and the list can grow
  // while one is in flight. A position is not an identity: an index captured
  // before the request and used after it is a promise that the list did not
  // move, which is not a promise this surface can keep. Marking the wrong row
  // saved would tell somebody a key is stored when nothing was written for it.
  const patch = (id: string, next: (row: PasteRow) => PasteRow) =>
    put(rows.map((row) => (row.id === id ? next(row) : row)));

  return {
    rows: () => rows,
    held: () => vault.size(),

    scan(blob) {
      // The vault has seen every value this surface has ever offered, so a
      // re-scan cannot resurrect a key the person said no to, nor duplicate one
      // still on screen. Done outside the updater on purpose: it mutates, and a
      // React state updater may be called twice.
      const fresh: PasteRow[] = [];
      for (const candidate of extractKeys(blob)) {
        const id = vault.admit(candidate.value);
        if (id) fresh.push(toPasteRow(id, candidate));
      }
      // Every row already on screen stays on screen. An undecided key that
      // vanished because a second blob was pasted is a key the person can no
      // longer save and was never told about.
      put([...rows, ...fresh]);
    },

    choose(id, provider) {
      patch(id, (current) => ({ ...current, chosen: provider }));
    },

    async accept(id) {
      const row = rows.find((one) => one.id === id);
      if (!row || row.status !== "pending") return;
      const target = rowTarget(row);
      if (!target || !row.providers.includes(target)) return;
      const value = vault.read(id).trim();
      if (!value) return;

      patch(id, (current) => ({ ...current, status: "saving", error: null }));
      try {
        const status = await effects.save(target, value);
        effects.saved(status);
        // Written, so the plaintext has no further use here.
        vault.forget(id);
        patch(id, (current) => ({ ...current, status: "saved", error: null }));
      } catch (e) {
        // Kept, because the person will want to try again.
        patch(id, (current) => ({ ...current, status: "pending", error: (e as Error).message }));
      }
    },

    dismiss(id) {
      vault.forget(id);
      patch(id, (current) => ({ ...current, status: "dismissed", error: null }));
    },
  };
}

/** The live surface. Reads presence from config and writes through the same
 * two doors ApiKeys.tsx uses. */
export function PasteKeys() {
  const { state, dispatch } = useStore();
  const [rows, setRows] = useState<PasteRow[]>([]);
  const [scanned, setScanned] = useState(false);
  const [navigationError, setNavigationError] = useState("");

  // The controller outlives any single render, so it reaches the store through
  // a ref rather than through whichever closure happened to build it.
  const latest = useRef(dispatch);
  useEffect(() => {
    latest.current = dispatch;
  }, [dispatch]);

  const held = useRef<PasteController | null>(null);
  if (!held.current) {
    held.current = createPasteController({
      render: setRows,
      save: (target, value) => {
        if (target === "flux") throw new Error("Use the Flux Router card in Models to connect this key.");
        const provider = PROVIDERS[target];
        if (provider.modelPreset) {
          const input = { action: "create" as const, preset: provider.modelPreset, key: value };
          const write = window.muragebox?.mutateProviderConnection
            ? window.muragebox.mutateProviderConnection(input)
            : api("/api/provider-connections/mutate", { method: "POST", body: JSON.stringify(input) });
          return write.then(async () => {
            window.dispatchEvent(new Event("murage:provider-connections-changed"));
            return api("/api/config") as Promise<ConfigStatus>;
          });
        }
        return provider.credential && window.muragebox?.setCredential
          ? window.muragebox.setCredential(provider.credential, value)
          : (api("/api/config", { method: "PUT", body: JSON.stringify(provider.body(value)) }) as Promise<ConfigStatus>);
      },
      saved: (status) => latest.current({ type: "configStatus", config: status }),
    });
  }
  const controller = held.current;

  return (
    <><PasteKeysBody
      rows={rows}
      scanned={scanned}
      onScan={(blob) => {
        setScanned(true);
        controller.scan(blob);
      }}
      onChoose={controller.choose}
      onAccept={(id) => {
        setNavigationError("");
        const row = controller.rows().find(item => item.id === id);
        if (row && rowTarget(row) === "flux") {
          if (controller.rows().some(item => item.id !== id && item.status !== "saved" && item.status !== "dismissed")) {
            setNavigationError("Save or dismiss the other pasted keys before opening Models. Nothing has been moved.");
            return;
          }
          controller.dismiss(id);
          dispatch({ type: "toggleAppSettings", open: true, section: "models" });
        } else void controller.accept(id);
      }}
      onDismiss={(id) => { setNavigationError(""); controller.dismiss(id); }}
      configured={state.config ?? null}
    />{navigationError && <p role="alert" className="mt-2 text-[12px] text-danger">{navigationError}</p>}</>
  );
}

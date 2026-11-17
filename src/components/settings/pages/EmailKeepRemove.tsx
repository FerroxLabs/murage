// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.19 Settings email Keep/Remove screen and restore result (restore-park r3.4b, the final server contract). One
// implementation for desktop, phone and browser, mounted inside the Bot email card. It talks only to the client module
// (src/lib/email-keep-remove-client.ts), which calls the real owner routes. Every address and every server line is a text
// node; tokens are echoed exactly as the latest view gave them and never shown.
//
// Tokens never outlive a view: after EVERY decision response the actionable view is invalidated, and decisions stay disabled
// until a fresh home view has been adopted. Reads and decisions carry a generation, and an obsolete completion is ignored.
import { useCallback, useEffect, useRef, useState } from "react";
import { ACTION_UNAVAILABLE_LINE, VIEW_LOAD_FAILED_LINE, VIEW_UNSUPPORTED_LINE, keptSummary, refusalLine, type DecisionAction } from "@/lib/email-keep-remove";
import {
  UnsupportedViewError, actionOf, canAct, defaultEmailKeepRemoveClient, hasRejectedPath, homeLines,
  type EmailKeepRemoveClient, type EmailKeepRemoveView, type EmailRow, type EmailSection,
} from "@/lib/email-keep-remove-client";

const ROW_WORDS = {
  title: "Email addresses to keep or remove",
  keptTitle: "Emails kept after the restore",
  keep: "Keep",
  remove: "Remove",
  tryAgainNow: "Try again now",
  confirmInventory: "Confirm inventory",
  dismiss: "Dismiss",
  retry: "Try again",
} as const;
const SECTION_WORDS: Partial<Record<EmailSection, string>> = {
  parked: "No bot uses this address", other_setup: "No bot uses this address", key_only: "Saved access with no address on file",
  removing: "Being removed", restore_check: "Restore check", kept: "Kept",
};

const buttonClass = "min-h-11 rounded-lg bg-control px-3 text-[13px] text-ink hover:bg-control disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

const rowLabel = (row: EmailRow): string => row.botName ?? SECTION_WORDS[row.section] ?? "Email address";
interface Refusal { rowId: string; line: string }

export function EmailKeepRemoveSection({ client = defaultEmailKeepRemoveClient }: { client?: EmailKeepRemoveClient }) {
  const [view, setView] = useState<EmailKeepRemoveView | null>(null);
  /** Decisions are possible only on a view this screen has just adopted whole. */
  const [actionable, setActionable] = useState(false);
  /** The latest refusal, kept apart from the rows: it survives a refresh that drops its row. */
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const alive = useRef(true);
  /** One number for every read and decision: a completion whose number is no longer current is obsolete and ignored. */
  const generation = useRef(0);
  const decisions = useRef(0);

  const adopt = useCallback((next: EmailKeepRemoveView) => { setView(next); setReadError(null); setActionable(true); }, []);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    setActionable(false);
    setLoading(true);
    try {
      const next = await client.view();
      if (alive.current && mine === generation.current) adopt(next);
    } catch (error) {
      // The last rows may stay on screen, but their actions stay disabled: nothing fresh was adopted.
      if (alive.current && mine === generation.current) setReadError(error instanceof UnsupportedViewError ? VIEW_UNSUPPORTED_LINE : VIEW_LOAD_FAILED_LINE);
    } finally {
      if (alive.current && mine === generation.current) setLoading(false);
    }
  }, [client, adopt]);
  useEffect(() => {
    alive.current = true;
    // A new client invalidates the view and any decision in flight for the old one.
    decisions.current += 1;
    setView(null); setActionable(false); setRefusal(null); setBusy(null); setReadError(null);
    void load();
    return () => { alive.current = false; generation.current += 1; };
  }, [load]);

  const decide = async (row: EmailRow, action: DecisionAction) => {
    if (busy || !actionable) return;
    const mine = ++decisions.current;
    const started = ++generation.current; // a decision invalidates every read still pending
    setBusy(row.id);
    setActionable(false);
    setRefusal(null);
    try {
      const answer = await client.act(row, action);
      if (!alive.current || started !== generation.current) return;
      if (answer.ok && answer.view) adopt(answer.view); // a complete home view, with its own fresh tokens
      else {
        if (!answer.ok) {
          const untokenedBotKeep = action === "keep" && row.section === "bot" && actionOf(row, "keep")?.tokenId === null;
          // The refusal belongs to the row the server names, else to the row that was chosen.
          setRefusal({ rowId: answer.rowId ?? row.id, line: refusalLine(answer, { action, untokenedBotKeep }) });
        }
        await load(); // no complete view came back (or a refusal): read the status again; until it lands nothing is actionable
      }
    } finally {
      if (alive.current && mine === decisions.current) setBusy(null);
    }
  };

  const homes = view ? homeLines(view) : [];
  // A kept row shows its address and, when the server sent one, its own line (verbatim, as text). A row with neither shows nothing.
  const keptRows = view ? view.rows.filter((row) => row.section === "kept" && (row.address !== null || row.line !== null)) : [];
  const kept = keptSummary(keptRows.map((row) => row.id));
  const keptShown = keptRows.slice(0, kept.shown.length);
  const rows = view ? view.rows.filter((row) => row.section !== "home" && row.section !== "kept") : [];
  const refusalHere = refusal !== null && rows.some((row) => row.id === refusal.rowId);
  if (!view && !readError) return null;
  if (!homes.length && !rows.length && !kept.shown.length && !refusal && !readError) return null;
  return (
    <div data-testid="email-keep-remove" className="mt-3 space-y-2 break-words text-[13px] text-ink-secondary">
      {readError && <div role="status" className="flex flex-wrap items-center justify-between gap-2">
        <p data-testid={readError === VIEW_UNSUPPORTED_LINE ? "email-unsupported-line" : "email-load-error"}>{readError}</p>
        <button type="button" aria-label="Reload email addresses" className={buttonClass} disabled={loading || busy !== null} onClick={() => void load()}>{ROW_WORDS.retry}</button>
      </div>}
      {homes.map((line, index) => <p key={index} role="status" data-testid="email-home-line">{line}</p>)}
      {refusal && !refusalHere && (
        <div role="status" data-testid="email-refusal-notice" className="flex flex-wrap items-center justify-between gap-2">
          <span>{refusal.line}</span>
          <button type="button" className={buttonClass} onClick={() => setRefusal(null)}>{ROW_WORDS.dismiss}</button>
        </div>
      )}
      {kept.shown.length > 0 && (
        <div data-testid="email-kept">
          <p className="font-medium text-ink">{ROW_WORDS.keptTitle}</p>
          <ul className="mt-1 space-y-0.5">
            {keptShown.map((row) => <li key={row.id}>{row.address}{row.line !== null && <span data-testid="email-kept-line" className={row.address !== null ? "block" : undefined}>{row.line}</span>}</li>)}
            {kept.more && <li>{kept.more}</li>}
          </ul>
        </div>
      )}
      {rows.length > 0 && (
        <div>
          <p className="font-medium text-ink">{ROW_WORDS.title}</p>
          <ul className="mt-1 space-y-3">
            {rows.map((row) => {
              const name = row.address ?? rowLabel(row);
              const off = busy !== null || !actionable;
              const keep = actionOf(row, "keep"), remove = actionOf(row, "remove"), again = actionOf(row, "try_again_now"), inventory = actionOf(row, "confirm_inventory");
              return (
                <li key={row.id} data-row-id={row.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span><span className="block text-ink">{name}</span>{row.address && <span className="block text-[12.5px]">{rowLabel(row)}</span>}</span>
                    <span className="flex flex-wrap gap-2">
                      {keep && <button type="button" aria-label={`${ROW_WORDS.keep} ${name}`} disabled={off || !canAct(row, "keep")} className={buttonClass} onClick={() => void decide(row, "keep")}>{ROW_WORDS.keep}</button>}
                      {remove && <button type="button" aria-label={`${ROW_WORDS.remove} ${name}`} disabled={off || !canAct(row, "remove")} className={buttonClass} onClick={() => void decide(row, "remove")}>{ROW_WORDS.remove}</button>}
                      {again && <button type="button" aria-label={`${ROW_WORDS.tryAgainNow} ${name}`} disabled={off || !canAct(row, "try_again_now")} className={buttonClass} onClick={() => void decide(row, "try_again_now")}>{ROW_WORDS.tryAgainNow}</button>}
                      {inventory && <button type="button" aria-label={`${ROW_WORDS.confirmInventory} ${name}`} disabled={off || !canAct(row, "confirm_inventory")} className={buttonClass} onClick={() => void decide(row, "confirm_inventory")}>{ROW_WORDS.confirmInventory}</button>}
                    </span>
                  </div>
                  {row.line !== null && <p data-testid="email-row-line" className="mt-1">{row.line}</p>}
                  {hasRejectedPath(row) && <p data-testid="email-row-action-error" className="mt-1">{ACTION_UNAVAILABLE_LINE}</p>}
                  {refusal?.rowId === row.id && <p role="status" data-testid="email-row-note" className="mt-1">{refusal.line}</p>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

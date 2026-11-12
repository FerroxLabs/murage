// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { PhoneSheet } from "./phone/PhoneSheet";

export type PreparedPackRow =
  | { id: string; state: "text"; author: string; text: string }
  | { id: string; state: "forgotten" | "unavailable" };

export interface DelegationPackDetailsProps {
  packId: string;
  sourceBotName: string;
  targetBotName: string;
  /** Read the owner route anew on each opening; never pass enqueue-time refs or cached words. */
  load: (packId: string) => Promise<{ rows: readonly PreparedPackRow[] }>;
}

/** L5b-3 supplies prepared only when a pack guard has passed a write.
 * A queued or note-only handoff need not have a pack at all. */
export type DelegationPackSurfaceProps =
  | (DelegationPackDetailsProps & { state: "prepared" })
  | (Pick<DelegationPackDetailsProps, "sourceBotName" | "targetBotName"> & {
    state: "queued" | "note-only";
    packId?: string;
    load?: DelegationPackDetailsProps["load"];
  });

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** @delegation-pack line Shows whether recent chat lines or only the note were prepared. */
export function DelegationPackLine(props: DelegationPackSurfaceProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [props.packId, props.state]);
  return (
    <div data-delegation-pack-line className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-ink-secondary">
      <span role="status">{props.state === "queued"
        ? `Asked ${props.targetBotName}. Recent chat context will be included where available.`
        : props.state === "note-only"
          ? `Only ${props.sourceBotName}'s note was prepared for ${props.targetBotName}.`
          : `Recent lines of this chat were prepared for ${props.targetBotName}`}</span>
      {props.state === "prepared" && <button type="button" aria-haspopup="dialog" aria-expanded={open}
        className={`min-h-11 rounded-lg px-1 text-ink underline underline-offset-2 hover:bg-raised ${FOCUS}`} onClick={() => setOpen(true)}>
        See what was prepared
      </button>}
      {open && props.state === "prepared" && <DelegationPackSheet key={props.packId} {...props} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** @delegation-pack chip Opens the recent chat lines prepared for this job. */
export function DelegationPackChip(props: DelegationPackSurfaceProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [props.packId, props.state]);
  if (props.state !== "prepared") return null;
  return (
    <div data-delegation-pack-chip className="min-w-0">
      <button type="button" aria-haspopup="dialog" aria-expanded={open}
        className={`inline-flex min-h-11 max-w-full items-center rounded-full border border-hairline/60 bg-raised/50 px-3 py-1 text-left text-[12.5px] text-ink-secondary hover:bg-raised ${FOCUS}`}
        onClick={() => setOpen(true)}>
        <span className="min-w-0 break-words">Recent context from your chat with {props.sourceBotName}</span>
      </button>
      {open && <DelegationPackSheet key={props.packId} {...props} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** @delegation-pack sheet Shows prepared rows through the owner reader under current forget. */
export function DelegationPackSheet({ packId, sourceBotName, targetBotName, load, onClose }: DelegationPackDetailsProps & { onClose: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ packId: string; rows: readonly PreparedPackRow[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setResult(null); setFailed(false);
    // The promise boundary also handles a synchronous refusal from a mock or transport.
    Promise.resolve().then(() => load(packId)).then(
      value => { if (current) setResult({ packId, rows: value.rows }); },
      () => { if (current) setFailed(true); },
    );
    return () => { current = false; };
  }, [packId, load, attempt]);
  const rows = result?.packId === packId ? result.rows : null;
  return (
    <PhoneSheet title={`Prepared for ${targetBotName} from your chat with ${sourceBotName}`} onClose={onClose}
      bodyData={{ "data-delegation-pack-sheet": packId }}>
      <div className="space-y-3 text-[13px] text-ink-secondary">
        {failed ? <div role="status">
          <p>Try again to see what was prepared.</p>
          <button type="button" className={`min-h-11 rounded-lg px-3 text-ink hover:bg-raised ${FOCUS}`} onClick={() => setAttempt(n => n + 1)}>Try again</button>
        </div> : rows === null ? <p role="status">Loading prepared lines…</p> : rows.length === 0
          ? <p>Nothing from this chat has been prepared for {targetBotName} yet.</p>
          : <ol className="space-y-3">{rows.map(row => <li key={row.id} className="break-words">
            {row.state === "text" ? <>
              <span className="font-medium text-ink">{row.author}</span>
              <p className="whitespace-pre-wrap text-ink">{row.text}</p>
            </> : row.state === "forgotten" ? "1 line you forgot" : "1 line without a preview"}
          </li>)}</ol>}
      </div>
    </PhoneSheet>
  );
}

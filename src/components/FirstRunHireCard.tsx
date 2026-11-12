// FIRSTRUN-1019 1.11: "Hire your first teammates". Four starter bots as checkboxes, the three great fits ticked. Hiring
// goes through POST /api/setup/hire, which ENSURES those agents exist (a repeat imports nothing); the card settles
// (POST /api/setup/card) only once the answer lists every ticked agent.

import { useState } from "react";

import { api, useStore, type Bot } from "@/state/store";
import { FIRST_RUN_COPY, hireButtonLabel, hireLead, joinNames } from "@/lib/first-run-copy";
import { FirstRunWorking } from "./FirstRunWorking";
import { FIRST_RUN_CHIP, FIRST_RUN_FOCUS, FIRST_RUN_PRIMARY, FIRST_RUN_QUIET, FirstRunBubble, FirstRunFailure, FirstRunLine, settleSetupCard } from "./FirstRunChrome";

const copy = FIRST_RUN_COPY.hire;

export const HIRE_ROWS = [
  { profileId: "starter-solo-business", key: "business-planner", fit: true },
  { profileId: "starter-solo-business", key: "draft-partner", fit: true },
  { profileId: "starter-business-team", key: "review-partner", fit: true },
  { profileId: "starter-business-team", key: "team-coordinator", fit: false },
] as const;

const FITS: readonly string[] = HIRE_ROWS.filter((row) => row.fit).map((row) => row.key);
const ALL: readonly string[] = HIRE_ROWS.map((row) => row.key);
const NAMES: Record<string, string> = Object.fromEntries(HIRE_ROWS.map((row) => [row.key, copy.rows[row.key].name]));

export function FirstRunHireCard({ settled, bot }: { settled: boolean; bot?: Bot | null }) {
  const { state } = useStore();
  const [pick, setPick] = useState<ReadonlySet<string>>(() => new Set(FITS));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");

  const ticked = HIRE_ROWS.map((row) => row.key as string).filter((key) => pick.has(key));

  const hire = async (keys: readonly string[]) => {
    if (busy || keys.length === 0) return;
    setBusy(true);
    setFailure("");
    try {
      const agents = HIRE_ROWS.filter((row) => keys.includes(row.key)).map((row) => ({ profileId: row.profileId, key: row.key }));
      const answer = await api("/api/setup/hire", { method: "POST", body: JSON.stringify({ agents }) });
      const hired: readonly { key: string }[] = Array.isArray(answer?.hired) ? answer.hired : [];
      if (!keys.every((key) => hired.some((entry) => entry.key === key))) throw new Error(copy.failure);
      await settleSetupCard("chat:hire");
    } catch {
      setFailure(copy.failure);
      setBusy(false);
    }
  };

  const notNow = async () => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      await settleSetupCard("chat:hire");
    } catch {
      setFailure(copy.failure);
      setBusy(false);
    }
  };

  if (settled) {
    const names = HIRE_ROWS.filter((row) => (state?.bots ?? []).some((candidate) => candidate.name === NAMES[row.key])).map((row) => NAMES[row.key]);
    return (
      <FirstRunBubble>
        <FirstRunLine>{names.length > 0 ? `Hire ${joinNames(names)}` : copy.notNowSettled}</FirstRunLine>
      </FirstRunBubble>
    );
  }

  return (
    <FirstRunBubble>
      <div className="text-[17px] font-semibold text-ink">{copy.heading}</div>
      <FirstRunLine>{hireLead(bot?.name ?? "")}</FirstRunLine>
      <ul className="mt-3 grid gap-2">
        {HIRE_ROWS.map((row) => {
          const words = copy.rows[row.key];
          const on = pick.has(row.key);
          return (
            <li key={row.key}>
              <label className={`flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2.5 ${on ? "border-accent bg-accent/10" : "border-hairline/40 bg-inset"}`}>
                <span className="flex min-w-0 items-start gap-3">
                  <input
                    type="checkbox"
                    className={`mt-1 size-4 shrink-0 accent-accent ${FIRST_RUN_FOCUS}`}
                    checked={on}
                    disabled={busy}
                    onChange={() => setPick((before) => {
                      const next = new Set(before);
                      if (next.has(row.key)) next.delete(row.key);
                      else next.add(row.key);
                      return next;
                    })}
                  />
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium text-ink">{words.name}<span className="ml-2 text-[12.5px] font-normal text-ink-secondary">{words.title}</span></span>
                    <span className="block text-[12.5px] leading-relaxed text-ink-secondary">{words.line}</span>
                  </span>
                </span>
                <span className={`shrink-0 text-[12.5px] ${row.fit ? "text-success" : "text-ink-secondary"}`}>{row.fit ? copy.greatFit : copy.later}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {busy ? (
        <FirstRunWorking bot={bot} words={ticked.length === 1 ? copy.bringingOne : copy.bringingMany} />
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={ticked.length === 0} className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`} onClick={() => void hire(ticked)}>
            {hireButtonLabel(ticked, FITS, ALL, NAMES)}
          </button>
          <button type="button" className={`${FIRST_RUN_CHIP} ${FIRST_RUN_FOCUS}`} onClick={() => { setPick(new Set(FITS)); void hire(FITS); }}>{copy.hireFits}</button>
          <button type="button" className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`} onClick={() => void notNow()}>{copy.notNow}</button>
        </div>
      )}
      <FirstRunFailure message={failure} />
    </FirstRunBubble>
  );
}

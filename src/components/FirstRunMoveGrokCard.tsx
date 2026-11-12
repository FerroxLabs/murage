// FIRSTRUN-1019 1.14: "Move from Grok Bot", posted only when Grok Bot data was found on this computer. Never imports on its
// own: "Move my bots" does, "Not now" settles. Settling is by its own record (POST /api/setup/card).

import { useEffect, useState } from "react";

import { api, type Bot } from "@/state/store";
import { FIRST_RUN_COPY } from "@/lib/first-run-copy";
import { FirstRunWorking } from "./FirstRunWorking";
import { FIRST_RUN_FOCUS, FIRST_RUN_PRIMARY, FIRST_RUN_QUIET, FirstRunBubble, FirstRunFailure, FirstRunLine, settleSetupCard, useSetupView } from "./FirstRunChrome";

const copy = FIRST_RUN_COPY.moveGrok;

export function FirstRunMoveGrokCard({ settled, bot }: { settled: boolean; bot?: Bot | null }) {
  const { view } = useSetupView();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [report, setReport] = useState<{ moved: string[]; notes: string[] } | null>(null);
  const [count, setCount] = useState<number>(view?.moveIn?.grok ?? 0);
  useEffect(() => {
    if (view?.moveIn?.grok) setCount(view.moveIn.grok);
  }, [view?.moveIn?.grok]);

  const move = async () => {
    if (busy) return;
    setBusy(true);
    setFailure("");
    try {
      const answer = await api("/api/move-in/grok", { method: "POST", body: JSON.stringify({}) });
      setReport({ moved: Array.isArray(answer?.moved) ? answer.moved : [], notes: Array.isArray(answer?.notes) ? answer.notes : [] });
      await settleSetupCard("detect:move-grok");
    } catch {
      setFailure(copy.failure);
    } finally {
      setBusy(false);
    }
  };
  const notNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await settleSetupCard("detect:move-grok");
    } catch {
      setFailure(copy.failure);
    } finally {
      setBusy(false);
    }
  };

  if (settled) {
    return (
      <FirstRunBubble>
        <FirstRunLine>{report ? copy.moved : copy.settled}</FirstRunLine>
        {report && report.moved.length > 0 && <FirstRunLine quiet>{report.moved.join(", ")}</FirstRunLine>}
        {report?.notes.map((note) => <FirstRunLine key={note} quiet>{note}</FirstRunLine>)}
      </FirstRunBubble>
    );
  }
  return (
    <FirstRunBubble>
      <div className="text-[17px] font-semibold text-ink">{copy.heading}</div>
      <FirstRunLine>{copy.body}</FirstRunLine>
      <FirstRunLine quiet>{`${copy.found} · ${count} ${count === 1 ? "Bot" : "Bots"}`}</FirstRunLine>
      {busy ? (
        <FirstRunWorking bot={bot} words={copy.moving} />
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={`${FIRST_RUN_PRIMARY} ${FIRST_RUN_FOCUS}`} onClick={() => void move()}>{copy.move}</button>
          <button type="button" className={`${FIRST_RUN_QUIET} ${FIRST_RUN_FOCUS}`} onClick={() => void notNow()}>{copy.notNow}</button>
        </div>
      )}
      <FirstRunFailure message={failure} />
    </FirstRunBubble>
  );
}

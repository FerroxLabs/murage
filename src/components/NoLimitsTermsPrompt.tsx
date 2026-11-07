import { useEffect, useRef, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { FullAccessWarning } from "./FullAccessWarning";

/** NOLIMITS-MEANS-IT section 6. One Accept on the desktop, for every bot. Until it is pressed every turn reads as today. */
// NOLIMITS v1 (copy W): the warning text changed, so an earlier Not now does not hide the new words
const NOT_NOW_KEY = "murage.noLimitsTerms.notNow.3";

function saidNotNow(): boolean {
  try { return localStorage.getItem(NOT_NOW_KEY) !== null; } catch { return false; }
}
function rememberNotNow(): void {
  try { localStorage.setItem(NOT_NOW_KEY, "1"); } catch { /* no storage: the dialog can open again at the next launch */ }
}

/** The phone's copy of the config has no `noLimitsTerms`, so only `false` means this desktop still owes the Accept. */
export const noLimitsTermsPending = (config: { noLimitsTerms?: { accepted: boolean } } | null | undefined): boolean =>
  config?.noLimitsTerms?.accepted === false;

/** A bot or one of its chats at No limits. */
export const anyAtNoLimits = (bots: ReadonlyArray<Pick<Bot, "noLimits" | "tasks">>): boolean =>
  bots.some((bot) => bot.noLimits === true || bot.tasks?.some((task) => task.noLimits === true));

/** Press Accept: the one desktop door for the terms. */
export function useAcceptNoLimitsTerms(): () => Promise<void> {
  const { dispatch } = useStore();
  return async () => {
    try {
      await api("/api/no-limits/terms", { method: "POST", body: JSON.stringify({ acknowledgeNoLimits: true }) });
      dispatch({ type: "noLimitsTermsAccepted" });
    } catch (error) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** Opens once, when the app has loaded on the desktop with a bot or chat at No limits and the terms not accepted. An
 * owner with no No limits bot never sees it. Not now changes nothing and does not ask again; Bot settings keeps a Review button. */
export function NoLimitsTermsPrompt() {
  const { state } = useStore();
  const accept = useAcceptNoLimitsTerms();
  const decided = useRef(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (decided.current || !state.hydrated || !state.config) return;
    decided.current = true;
    if (noLimitsTermsPending(state.config) && anyAtNoLimits(state.bots) && !saidNotNow()) setOpen(true);
  }, [state.hydrated, state.config, state.bots]);
  return (
    <FullAccessWarning
      open={open}
      botName=""
      level="unlimited"
      terms
      onThisComputer={false}
      onCancel={() => { rememberNotNow(); setOpen(false); }}
      onConfirm={() => { setOpen(false); void accept(); }}
    />
  );
}

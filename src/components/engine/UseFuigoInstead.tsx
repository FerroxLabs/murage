// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.14 FIRST-ENGINE-REPICK section 6 and F0: on a sign-in wall, "Use Fuigo instead" is the primary button and signing in to the
// other engine is the secondary action. Shown only when Fuigo can answer now (exactly one Fuigo engine with a model). The tap is the
// owner's choice: it carries the bot's engineRev as drawn and the chat it was drawn in, and the server writes nothing if the engine
// changed since (409 stale). Never pressed for the owner, never on a timer. This is the only way a bot on a working engine that is not
// Fuigo reaches Fuigo. 1.0.15 M5: with no Fuigo able to answer yet, the wall leads with the Flux key card instead.
import { useState, type ReactNode } from "react";
import { api, type Bot, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { FluxKeyCard } from "../FluxKeyCard";

const fuigoEngines = (instances: readonly InstanceInfo[]) => instances.filter((instance) => instance.driverKind === "fuigoAgent"
  && instance.enabled !== false && instance.snapshot.state === "available" && Boolean(instance.models.default || instance.models.options[0]?.id));

/** The one Fuigo engine that can answer now, by the same rule the server's engine pass uses (a named default or a first listed model). */
export function usableFuigo(instances: readonly InstanceInfo[]): InstanceInfo | undefined {
  const fuigo = fuigoEngines(instances);
  return fuigo.length === 1 ? fuigo[0] : undefined;
}

/** Whether the wall offers the tap: Fuigo can answer and the bot is not already on it. */
export function offersFuigo(bot: Pick<Bot, "modelSelection">, instances: readonly InstanceInfo[]): boolean {
  const fuigo = usableFuigo(instances);
  return fuigo !== undefined && bot.modelSelection.instanceId !== fuigo.instanceId;
}

/** What leads a sign-in wall for a bot that is not on Fuigo: the tap when Fuigo can answer, the Flux key card when no Fuigo can answer
 * yet, nothing extra otherwise (the bot is on Fuigo, or two Fuigo engines leave the pick to the owner). */
export function wallLead(bot: Pick<Bot, "modelSelection">, instances: readonly InstanceInfo[]): "fuigo" | "fluxKey" | null {
  if (instances.some((instance) => instance.instanceId === bot.modelSelection.instanceId && instance.driverKind === "fuigoAgent")) return null;
  if (offersFuigo(bot, instances)) return "fuigo";
  return fuigoEngines(instances).length === 0 ? "fluxKey" : null;
}

export const PRIMARY_BUTTON = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

/** The tap's request: the revision the card was drawn with and the chat it was drawn in. */
export function fuigoTapRequest(bot: Pick<Bot, "id" | "threadId" | "engineRev">): [string, { method: "POST"; body: string }] {
  return [`/api/bots/${bot.id}/use-fuigo`, { method: "POST", body: JSON.stringify({ engineRev: bot.engineRev ?? 0, threadId: bot.threadId }) }];
}

/** One press of the tap. Answers the note the card shows: empty when the move landed, else the server's words (a 409 "This bot's
 * engine changed..." or "Fuigo is not ready yet."); the stream then redraws the card with the bot as it is now. */
export async function runFuigoTap(bot: Pick<Bot, "id" | "threadId" | "engineRev">, call: typeof api = api): Promise<string> {
  try { await call(...fuigoTapRequest(bot)); return ""; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

export function UseFuigoInstead({ bot, engineName, instances, children, className }: {
  bot: Pick<Bot, "id" | "threadId" | "modelSelection" | "engineRev">;
  /** The engine whose sign-in is missing, as the wall names it. */
  engineName: string;
  instances: readonly InstanceInfo[];
  /** The wall's own sign-in action, shown under the primary action as the secondary one. */
  children?: ReactNode;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const lead = wallLead(bot, instances);
  if (lead === null) return <>{children}</>;
  const tap = async () => {
    setBusy(true); setNote("");
    try { setNote(await runFuigoTap(bot)); } finally { setBusy(false); }
  };
  return (
    <div data-use-fuigo-instead className={className}>
      <p className="text-[12.5px] leading-relaxed text-ink-secondary">{t("engineWall.needsOwnAccount", { name: engineName })}</p>
      {lead === "fuigo" ? (
        <button type="button" data-use-fuigo-primary className={`mt-2 ${PRIMARY_BUTTON}`} disabled={busy} onClick={() => void tap()}>
          {t("engineWall.useFuigo")}
        </button>
      ) : (
        <div data-flux-key-primary className="mt-2"><FluxKeyCard /></div>
      )}
      {note ? <p role="status" className="mt-2 text-[12px] text-ink-secondary">{note}</p> : null}
      {children ? <div data-use-fuigo-secondary className="mt-3">{children}</div> : null}
    </div>
  );
}

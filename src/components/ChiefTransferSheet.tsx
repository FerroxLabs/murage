// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CHIEF-TRANSFER-1023 D3: the one sheet that moves the workspace Chief role. Every line comes from one server preview; the commit carries that
// preview's fence, so a sheet that went stale is refused and re-read, never half-applied. Cancel writes nothing.
import { useEffect, useId, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { useFocusTrap } from "@/lib/focus-trap";
import { closeChiefTransfer, useChiefTransferRequest, type ChiefTransferRequest } from "@/lib/chief-transfer";
import { LayerSurface } from "./LayerSurface";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";

const CHANNEL_NAME: Record<string, string> = { telegram: "Telegram", slack: "Slack", discord: "Discord", signal: "Signal", whatsapp: "WhatsApp" };
const button = "min-h-10 rounded-lg border border-hairline/50 px-3 py-2 text-[13px] text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

interface Level { id: string; name: string; level: string; rank: number; standingAllows: number; eligible?: boolean; reason?: string | null }
interface Pairing { channel: string; connectionId: string; live: boolean; checked: boolean }
interface Preview {
  from: Level; to: Level | null; formerRole: "leader" | "member" | null;
  candidates: Array<{ id: string; name: string; eligible: boolean; reason: string | null }>;
  routines: Array<{ id: string; name: string; schedule: unknown }>; archiveRoutinesFail: boolean;
  pairings: Pairing[]; appAccessResets?: Array<{ id: string; name: string; apps: string[] }>; higherLevelApps: string[]; inFlight: number; fence: unknown;
}
interface Outcome { from: string; to: string; fromName: string; toName: string; status: "done" | "nothing-changed"; reason?: string; channels: Array<{ channel: string; result: string; reconnecting?: boolean }>; stoppedRuns: number }

const CONNECTED_APP_NAME: Record<string, string> = { gmail: "Gmail", googlecalendar: "Google Calendar", slack: "Slack" };
const apps = (names: string[]) => names.map((name) => CHANNEL_NAME[name] ?? name).join(", ");
function scheduleText(schedule: unknown): string {
  const s = schedule as { kind?: string; label?: string; cron?: string; at?: number } | null;
  return s?.label ?? s?.cron ?? s?.kind ?? "";
}
function resultLine(row: { channel: string; result: string; reconnecting?: boolean }, toName: string): string {
  const name = CHANNEL_NAME[row.channel] ?? row.channel;
  if (row.result === "moved") return row.reconnecting ? `${name}: moved to ${toName} and reconnecting.` : `${name}: moved to ${toName}.`;
  if (row.result === "paused:left-paused") return `${name}: paused, as you chose. You will pair it again in Settings.`;
  return `${name} is paused. Pair it again in Settings.`;
}

function Sheet({ request, initialOutcome, onFinished }: { request: ChiefTransferRequest; initialOutcome?: Outcome; onFinished?: () => void }) {
  const { state, dispatch } = useStore();
  const [to, setTo] = useState<string | undefined>(request.to);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(initialOutcome ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null), serial = useRef(0);
  const titleId = useId();
  const layer = useFocusTrap(dialog, true, { name: "chief-transfer", kind: "dialog", initialFocus: "[data-cancel]", onEscape: () => finish() });

  const finish = () => { closeChiefTransfer(); onFinished?.(); };
  const load = async (target: string | undefined, why?: string) => {
    const revision = ++serial.current;
    try {
      const query = `from=${encodeURIComponent(request.from)}${target ? `&to=${encodeURIComponent(target)}` : ""}`;
      const next = (await api(`/api/chief-transfer/preview?${query}`)) as Preview;
      if (revision !== serial.current) return;
      setPreview(next); setNote(why ?? null);
      setChecked(Object.fromEntries(next.pairings.map((p) => [p.channel, p.live])));
    } catch (cause) {
      if (revision !== serial.current) return;
      const body = (cause as { body?: { code?: string } })?.body;
      setFailure(body?.code === "chief-transfer-stale" ? "The Chief changed. Close this and try again." : "Could not check the hand-over. Nothing changed.");
    }
  };
  useEffect(() => { if (!initialOutcome) void load(to); return () => { serial.current++; }; }, [to]);

  const commit = async () => {
    if (!preview || !to || busy) return;
    setBusy(true);
    try {
      const move = preview.pairings.filter((p) => p.live && checked[p.channel]).map((p) => p.channel);
      const result = (await api("/api/chief-transfer", { method: "POST", body: JSON.stringify({ fence: preview.fence, move }) })) as { outcome: Outcome };
      setOutcome(result.outcome);
    } catch (cause) {
      const body = (cause as { body?: { code?: string; error?: string; outcome?: Outcome } })?.body;
      if (body?.code === "chief-transfer-stale") await load(to, "Something changed. Check again.");
      else if (body?.code === "chief-transfer-busy") await load(to, "A hand-over is finishing. Check again in a moment.");
      else if (body?.outcome) setOutcome(body.outcome);
      else setFailure(body?.error ?? "Nothing changed. Murage could not complete the hand-over.");
    } finally { setBusy(false); }
  };

  const nameOf = (id: string) => state.bots.find((bot) => bot.id === id)?.name ?? "this bot";
  const fromName = preview?.from.name ?? nameOf(request.from);
  const toName = preview?.to?.name ?? (to ? nameOf(to) : "");
  const former = preview?.formerRole === "leader" ? "a team leader" : "a team member";
  const live = preview?.pairings.filter((p) => p.live) ?? [];
  const movedApps = live.filter((p) => checked[p.channel]).map((p) => p.channel);
  const warn = preview?.to && movedApps.filter((app) => preview.higherLevelApps.includes(app));
  const ready = !!preview?.to && preview.to.eligible !== false && !busy;

  return (
    <LayerSurface handle={layer}>
      <div className="overlay-inset fixed inset-x-0 top-0 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/60 p-3" role="presentation">
        <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
          className={`${BOX_FRAME} max-h-[calc(var(--vvh,100dvh)-1.5rem)] w-full min-w-0 max-w-[520px] overflow-y-auto rounded-2xl border border-hairline bg-panel text-ink`}>
          <BoxHead className="px-5 pt-5">
            <h2 id={titleId} className="min-w-0 break-words text-[17px] font-medium">
              {outcome ? (outcome.status === "done" ? `${outcome.toName} is now Chief of Staff` : "Nothing changed") : toName ? `${fromName} hands the Chief role to ${toName}.` : `Pick who runs the workspace next.`}
            </h2>
          </BoxHead>
          <BoxBody className="space-y-3 px-5 py-3 text-[13px]">
            {failure && <p role="alert" className="text-danger">{failure}</p>}
            {outcome ? (
              <div role="status" aria-live="polite" className="space-y-1.5">
                {outcome.status === "nothing-changed" ? <p>{`Nothing changed. ${outcome.reason ?? ""}`.trim()}</p> : (
                  <>
                    <p>{outcome.fromName} stays on as part of the team. Each bot kept its approval level.</p>
                    {outcome.channels.length === 0 && <p>No chat apps were connected to {outcome.fromName}.</p>}
                    {outcome.channels.map((row) => <p key={row.channel}>{resultLine(row, outcome.toName)}</p>)}
                    {outcome.stoppedRuns > 0 && <p>{outcome.stoppedRuns === 1 ? "One message in progress was stopped. Send it again." : `${outcome.stoppedRuns} messages in progress were stopped. Send them again.`}</p>}
                  </>
                )}
              </div>
            ) : !preview ? <p role="status" aria-busy="true">Checking what goes with the role…</p> : (
              <>
                {note && <p role="status">{note}</p>}
                {!request.to && (
                  <label className="block">
                    <span className="mb-1 block text-ink-secondary">New Chief of Staff</span>
                    <select aria-label="New Chief of Staff" className="w-full rounded-lg border border-hairline/50 bg-panel px-2 py-2" value={to ?? ""} onChange={(event) => setTo(event.target.value || undefined)}>
                      <option value="">Choose a bot</option>
                      {preview.candidates.map((row) => <option key={row.id} value={row.id} disabled={!row.eligible}>{row.eligible ? row.name : `${row.name} (${row.reason})`}</option>)}
                    </select>
                  </label>
                )}
                {preview.to && <p>{fromName} stays on as {former}.</p>}
                <section aria-label="Routines">
                  <h3 className="font-medium">Routines</h3>
                  {preview.routines.length === 0 ? <p className="text-ink-secondary">{fromName} runs no routines.</p> : (
                    <>
                      <p>{fromName} runs {preview.routines.length} {preview.routines.length === 1 ? "routine" : "routines"}. They stay with {fromName}.</p>
                      {preview.appAccessResets?.some(reset => reset.id === preview.from.id) && <p className="text-warning">Routines that use {fromName}'s connected apps may need you to grant access again.</p>}
                      <ul className="ml-4 list-disc">{preview.routines.map((routine) => <li key={routine.id}>{routine.name}{scheduleText(routine.schedule) ? `, ${scheduleText(routine.schedule)}` : ""}</li>)}</ul>
                      {request.source === "archive" && preview.archiveRoutinesFail && <p className="text-warning">If you archive {fromName}, these routines will fail each time they are due until you restore it.</p>}
                    </>
                  )}
                </section>
                <section aria-label="Chat apps">
                  <h3 className="font-medium">Chat apps</h3>
                  {preview.pairings.length === 0 && <p className="text-ink-secondary">No chat apps are connected to {fromName}.</p>}
                  {preview.pairings.map((p) => {
                    const name = CHANNEL_NAME[p.channel] ?? p.channel;
                    return p.live ? (
                      <label key={p.channel} className="flex items-start gap-2 py-0.5">
                        <input type="checkbox" checked={checked[p.channel] === true} onChange={(event) => setChecked({ ...checked, [p.channel]: event.target.checked })} />
                        <span>{checked[p.channel] ? `${name}: move to ${toName || "the new Chief"}` : `${name}: stays paused. You will pair it again in Settings.`}</span>
                      </label>
                    ) : <p key={p.channel} className="text-ink-secondary">{name}: not connected, nothing to move.</p>;
                  })}
                </section>
                {preview.to && (
                  <section aria-label="Permissions">
                    <h3 className="font-medium">Permissions</h3>
                    <p>{fromName}: {preview.from.level}. {toName}: {preview.to.level}. Approval levels stay with each bot.</p>
                    {preview.appAccessResets?.map(reset => <p key={reset.id} className="text-warning">{reset.name}'s connected-app access is reset when its role changes{reset.apps.length ? ` (${reset.apps.map(app => CONNECTED_APP_NAME[app] ?? app).join(", ")})` : ""}. You will grant it again.</p>)}
                    <button type="button" className="mt-1 underline" onClick={() => { const target = preview.to!.id; finish(); dispatch({ type: "select", id: target }); dispatch({ type: "toggleSettings", open: true }); }}>Change {toName}'s permissions</button>
                    {!!warn && warn.length > 0 && <p className="text-warning">Messages from {apps(warn)} will reach {toName}, which works with {preview.to.level}.</p>}
                  </section>
                )}
                {preview.inFlight > 0 && movedApps.length > 0 && (
                  <p>{fromName} is answering {preview.inFlight} {preview.inFlight === 1 ? "message" : "messages"}. {preview.inFlight === 1 ? "It" : "They"} will be stopped; send {preview.inFlight === 1 ? "it" : "them"} again after the move. Your chat account stays linked.</p>
                )}
              </>
            )}
          </BoxBody>
          <BoxFoot className="flex flex-wrap justify-end gap-2 px-5 pb-5">
            {outcome ? (
              <>
                {request.source === "archive" && outcome.status === "done" && (
                  <button type="button" className={button} onClick={() => { void api(`/api/bots/${encodeURIComponent(outcome.from)}`, { method: "PATCH", body: JSON.stringify({ hidden: true }) }).finally(finish); }}>Archive {outcome.fromName}</button>
                )}
                <button type="button" data-cancel className={button} onClick={finish}>Done</button>
              </>
            ) : (
              <>
                <button type="button" data-cancel className={button} onClick={finish}>Cancel</button>
                <button type="button" data-primary="true" disabled={!ready} className={`${button} bg-accent text-white disabled:opacity-40`} onClick={commit}>Hand over</button>
              </>
            )}
          </BoxFoot>
        </div>
      </div>
    </LayerSurface>
  );
}

/** Mounted once at the app root: opens when anything calls openChiefTransfer(). */
export function ChiefTransferSheet() {
  const request = useChiefTransferRequest();
  const [late, setLate] = useState<Outcome | null>(null);
  // D4 "one outcome": a hand-over that finished while the app was closed (boot recovery) or in another window is shown once, here
  useEffect(() => {
    let alive = true;
    void api("/api/chief-transfer/outcome").then((answer: { outcome?: Outcome | null } | null) => { if (alive && answer?.outcome) setLate(answer.outcome); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  if (request) return <Sheet key={`${request.from}:${request.to ?? ""}`} request={request} />;
  return late ? <Sheet key={`late:${late.from}:${late.to}`} request={{ from: late.from, to: late.to, source: "sidebar" }} initialOutcome={late} onFinished={() => setLate(null)} /> : null;
}

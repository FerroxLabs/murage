// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cloud Door v2: connect this computer to your Cloud home from the browser. The app makes its own key, opens murage.ai,
// and the site hands a one-time link back through murage://. "Use copied link" is the same hand-over by hand: main reads
// the clipboard itself, so this window never holds the link. Runs in the MAIN (local) window only. Nothing secret is ever
// held here: no key, no ticket, no token. What happened last (a refusal, a lost answer, a Connect that took too long) stays
// on the panel whether or not a Connect is still pending.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { cloudCopy } from "@/lib/cloud-copy";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { cloudHomeBridge, type CloudHomeBridge, type PairedHome } from "@/lib/cloud-workspace";
import { EngineSignIns, type SignInRequest } from "./EngineSignIns";

export const CONNECT_WINDOW_MS = 10 * 60_000;
export const CONNECT_POLL_MS = 2_000;

/** Whole seconds left of the 10 minutes (never below 0). */
export const connectSecondsLeft = (startedAt: number, now: number) => Math.max(0, Math.ceil((startedAt + CONNECT_WINDOW_MS - now) / 1000));
export const formatCountdown = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * "closed": this build cannot verify a Cloud home yet (main reports connectStatus().open === false); the panel says so.
 * "pending": a key is made and the browser is open, with the ten-minute countdown.
 * "attempted": the home was asked and its answer may be lost; no countdown, the key is kept for the next Connect.
 */
export type ConnectPhase = "idle" | "pending" | "attempted" | "paired" | "closed";

export interface ConnectResult { code: string; message: string; at: number; retryAfterMs?: number }

/** Every outcome main reports has its own words in en.json; an unknown code falls back to main's own message. */
const RESULT_KEYS: Record<string, LocaleKey> = {
  "expired": "cloudConnect.result.expired",
  "hold-required": "cloudConnect.result.holdRequired",
  "too-many-devices": "cloudConnect.result.tooManyDevices",
  "refused": "cloudConnect.result.refused",
  "too-many-tries": "cloudConnect.result.tooManyTries",
  "home-busy": "cloudConnect.result.homeBusy",
  "lost": "cloudConnect.result.lost",
  "took-too-long": "cloudConnect.result.tookTooLong",
  "remove-on-my-cloud": "cloudConnect.result.removeOnMyCloud",
  "other-connect": "cloudConnect.result.otherConnect",
  "bad-link": "cloudConnect.result.badLink",
  "pin-mismatch": "cloudConnect.result.pinMismatch",
  "unreachable": "cloudConnect.result.unreachable",
};
export const resultText = (result: ConnectResult) => (RESULT_KEYS[result.code] ? t(RESULT_KEYS[result.code]!) : result.message);
/** Seconds until a 429 lets the person try again, or 0. */
export const retrySecondsLeft = (result: ConnectResult | null, now: number) => (result?.retryAfterMs ? Math.max(0, Math.ceil((result.at + result.retryAfterMs - now) / 1000)) : 0);
/** A refusal is an alert; "what happened" lines (lost answer, too long, remove on My Cloud) are a polite status. */
const ALERT_CODES = new Set(["expired", "hold-required", "too-many-devices", "refused", "too-many-tries", "home-busy", "other-connect", "bad-link", "pin-mismatch"]);

export interface ConnectHomeViewProps {
  phase: ConnectPhase;
  secondsLeft: number;
  paired: PairedHome[];
  /** What happened last; shown in every phase but paired. */
  lastResult: ConnectResult | null;
  /** Seconds before a 429 lets Connect run again (0: no wait). */
  retrySeconds: number;
  busy: boolean;
  error: string;
  /** A revoked computer: shown above the Connect button. */
  notice: string;
  onConnect(): void;
  onCancel(): void;
  onPaste(): void;
  onOpen(homeId: string): void;
  onDisconnect(homeId: string): void;
  /** B3 WP5: the engine sign-ins under a connected home's row (EngineSignIns). Absent: the row has Open and Disconnect only. */
  signIns?(homeId: string): ReactNode;
}

const button = "rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset disabled:opacity-50";

export function ConnectHomeView(props: ConnectHomeViewProps) {
  const { phase, busy, error, notice, lastResult, retrySeconds } = props;
  const waiting = retrySeconds > 0;
  const result = lastResult && phase !== "paired" && phase !== "closed" ? (
    <div className="flex flex-col gap-1">
      <p role={ALERT_CODES.has(lastResult.code) ? "alert" : "status"} className={ALERT_CODES.has(lastResult.code) ? "text-danger" : "text-ink-secondary"}>{resultText(lastResult)}</p>
      {waiting ? <p className="text-ink-secondary" aria-live="off">{t("cloudConnect.retryIn")}: <span className="font-mono">{formatCountdown(retrySeconds)}</span></p> : null}
    </div>
  ) : null;
  return (
    <section aria-label={cloudCopy.connectButton} className="flex flex-col gap-3 rounded-lg bg-card p-4 text-[13px] text-ink">
      <h2 className="text-[15px] font-semibold">{cloudCopy.pairTitle}</h2>
      {notice && phase !== "paired" ? <p role="status" className="text-ink-secondary">{notice}</p> : null}
      {phase === "paired" ? (
        <ul className="flex flex-col gap-2">
          {props.paired.map((home) => (
            <li key={home.homeId} className="flex flex-col gap-2 rounded-md bg-inset p-3">
              <span className="text-accent-text">{cloudCopy.pairPaired}</span>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={button} disabled={busy} onClick={() => props.onOpen(home.homeId)}>{cloudCopy.connectOpen}</button>
                <button type="button" className={button} disabled={busy} onClick={() => props.onDisconnect(home.homeId)}>{cloudCopy.connectDisconnect}</button>
              </div>
              {props.signIns?.(home.homeId) ?? null}
            </li>
          ))}
        </ul>
      ) : phase === "closed" ? (
        <p role="status" className="text-ink-secondary">{cloudCopy.cloudNotOpen}</p>
      ) : phase === "idle" ? (
        <>
          {result}
          <div><button type="button" className={button} disabled={busy || waiting} onClick={props.onConnect}>{cloudCopy.connectButton}</button></div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          {phase === "pending" ? (
            <>
              <p>{cloudCopy.connectPending}</p>
              <p className="text-ink-secondary">{cloudCopy.connectBrowserNote}</p>
              <p className="text-ink-secondary" aria-live="off">{cloudCopy.connectCountdown}: <span className="font-mono">{formatCountdown(props.secondsLeft)}</span></p>
            </>
          ) : null}
          {result}
          <div className="flex flex-wrap gap-2">
            {phase === "attempted" ? <button type="button" className={button} disabled={busy || waiting} onClick={props.onConnect}>{cloudCopy.connectAgain}</button> : null}
            <button type="button" className={button} disabled={busy} onClick={props.onPaste}>{t("cloudConnect.useCopiedLink")}</button>
            <button type="button" className={button} disabled={busy} onClick={props.onCancel}>{cloudCopy.connectCancel}</button>
          </div>
          <p className="text-ink-secondary">{t("cloudConnect.useCopiedLinkNote")}</p>
        </div>
      )}
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
    </section>
  );
}

const messageOf = (cause: unknown) => (cause instanceof Error && cause.message ? cause.message : "Something went wrong. Try again.");

/** `onChanged` runs after the computer connects or disconnects so the switch can reread what is paired. */
export function ConnectHome({ bridge = cloudHomeBridge(), paired, onChanged, signInRequest, onSignInRequestHandled }: { bridge?: CloudHomeBridge; paired: PairedHome[]; onChanged?: () => void; signInRequest?: SignInRequest | null; onSignInRequestHandled?: () => void }) {
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [lastResult, setLastResult] = useState<ConnectResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState(true); // false only when main says Cloud is not open on this build yet
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const readStatus = useCallback(async () => {
    if (!bridge) return;
    try {
      const status = await bridge.connectStatus();
      setOpen(status.open !== false);
      setPendingSince(status.pending ? status.startedAt : null);
      setAttempted(status.pending && status.attempted === true);
      setLastResult(status.lastResult ?? null);
      setNotice(status.disconnected ? cloudCopy.disconnected : "");
      if (status.paired && paired.length === 0) changed.current?.();
      return status;
    } catch { return null; /* a status that cannot be read leaves the panel as it is */ }
  }, [bridge, paired.length]);

  useEffect(() => { void readStatus(); }, [readStatus]);
  // A link main handled (door, connect-cloud, open-cloud) changes what the panel shows: read it again at once.
  useEffect(() => bridge?.onLinkEvent?.(() => { void readStatus(); }), [bridge, readStatus]);
  // While a Connect is pending the app finishes it by itself when the link arrives; look for that every couple of seconds.
  // A 429 wait counts down on its own.
  const counting = pendingSince !== null || Boolean(lastResult?.retryAfterMs);
  useEffect(() => {
    if (!counting) return;
    const timer = pendingSince !== null ? setInterval(() => { setNow(Date.now()); void readStatus(); }, CONNECT_POLL_MS) : null;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => { if (timer) clearInterval(timer); clearInterval(tick); };
  }, [counting, pendingSince, readStatus]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  };
  if (!bridge) return null;
  const secondsLeft = pendingSince === null ? 0 : connectSecondsLeft(pendingSince, now);
  const phase: ConnectPhase = paired.length > 0 ? "paired" : !open ? "closed" : pendingSince === null ? "idle" : attempted ? "attempted" : "pending";
  return (
    <ConnectHomeView
      phase={phase} secondsLeft={secondsLeft} paired={paired} lastResult={lastResult} retrySeconds={retrySecondsLeft(lastResult, now)}
      busy={busy} error={error} notice={notice}
      onConnect={() => void run(async () => { const started = await bridge.connectStart(); setNotice(""); setLastResult(null); setNow(Date.now()); setPendingSince(started.startedAt); })}
      onCancel={() => void run(async () => { await bridge.connectCancel(); setPendingSince(null); await readStatus(); })}
      onPaste={() => void run(async () => {
        let done: { homeId: string };
        try { done = await bridge.connectPaste(); }
        catch (cause) {
          // The home's answer is already on the panel as lastResult; say it once, not twice.
          if ((await readStatus())?.lastResult) return;
          throw cause;
        }
        setPendingSince(null);
        await bridge.open(done.homeId);
        changed.current?.();
        await readStatus();
      })}
      onOpen={(homeId) => void run(async () => { await bridge.open(homeId); })}
      onDisconnect={(homeId) => void run(async () => { await bridge.disconnect(homeId); changed.current?.(); })}
      signIns={(homeId) => <EngineSignIns bridge={bridge} homeId={homeId} busy={busy} onError={setError} request={signInRequest} onRequestHandled={onSignInRequestHandled} />}
    />
  );
}

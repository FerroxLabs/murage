import { signalKeptCopy } from "../../shared/signal-kept-copy.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, useStoreIfAny } from "@/state/store";
import { signalSettingsEnabled } from "@/lib/settings-card-registry";
import type { ChannelState, ServiceResendResult, SignalProblem } from "../../server/channels/signal/types";

type Mutation = "keep-both-and-link" | "link" | "connect-again" | "disconnect" | "resend" | "leave-it" | "dismiss" | "finish-revocation" | "fix-permissions" | "retry-notes";
type OpenAction = "open-in-murage" | "show-folder" | "check-for-updates" | "open-storage";
export interface SignalClient {
  status(): Promise<ChannelState>;
  action(action: Mutation, payload: Record<string, unknown>): Promise<{ status: ChannelState; result?: ServiceResendResult }>;
  open(action: OpenAction, payload: Record<string, unknown>): Promise<void>;
}
const problemCopy: Record<SignalProblem, { line: string; label?: string; action?: Mutation | OpenAction | "review" }> = {
  "kept-check": { line: "Murage paused Signal to preserve your connection." },
  "kept-busy": { line: "Signal may still be running on this computer. Quit Murage, wait a minute, and open it again. If this stays, restart your computer." },
  "link-required": { line: "Signal needs a new link on this computer.", label: "Connect again", action: "connect-again" },
  "identity-unavailable": { line: "Signal did not say which account this is. Connect again to fix it.", label: "Connect again", action: "connect-again" },
  "identity-mismatch": { line: "A different Signal account answered. Disconnect to link this one.", label: "Disconnect", action: "disconnect" },
  "needs-update": { line: "Signal needs a newer Murage.", label: "Check for updates", action: "check-for-updates" },
  "storage-permissions": { line: "Murage cannot protect the Signal files on this computer.", label: "Fix permissions", action: "fix-permissions" },
  "storage-owner": { line: "Another account on this computer may have Murage's Signal keys, so Murage stopped using them. In Signal on your phone, open Settings, Linked devices and remove Murage. Then connect again.", label: "Connect again", action: "connect-again" },
  "revoke-recovery-required": { line: "Murage did not finish disconnecting Signal.", label: "Finish disconnecting", action: "finish-revocation" },
  "disk-full": { line: "Murage has no room to save Signal notes.", label: "Show folder", action: "show-folder" },
  "storage-slow": { line: "Murage has no room to save Signal notes.", label: "Show folder", action: "show-folder" },
  "ledger-write-failed": { line: "Murage could not save a Signal note.", label: "Try again", action: "retry-notes" },
  "notes-stuck": { line: "Murage could not save 1 Signal note.", label: "Try again", action: "retry-notes" },
  "reply-lost": { line: "Murage lost track of the answer to 1 Signal note.", label: "Review", action: "review" },
};
const secondary = "min-h-11 rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink hover:bg-control disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent-border";
const primary = "min-h-11 rounded-lg bg-accent px-3 py-2 text-[13px] text-accent-ink disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent-border";

/** Same card and defaults in Simple and Advanced; tests inject a port-free client. */
export function SignalSettings({ client: injected, enabled = signalSettingsEnabled }: { client?: SignalClient; enabled?: boolean }) {
  const store = useStoreIfAny();
  const client = useMemo<SignalClient>(() => injected ?? {
    status: () => api("/api/signal/status"),
    action: async (action, payload) => {
      try { return await api(`/api/signal/${action}`, { method: "POST", body: JSON.stringify(payload) }, 0); }
      catch (error) {
        const body = (error as { body?: { result?: ServiceResendResult; status?: ChannelState } }).body;
        if (body?.result && body.status) return { result: body.result, status: body.status };
        throw error;
      }
    },
    open: async (action, payload) => {
      if (action === "open-storage" || action === "check-for-updates") {
        store?.dispatch({ type: "toggleAppSettings", open: true, section: action === "open-storage" ? "backups" : "about", anchor: action === "open-storage" ? "storage-heading" : "updates-heading" });
      } else if (action === "show-folder") {
        await api("/api/signal/show-folder", { method: "POST", body: "{}" }, 0);
      } else {
        const { target } = await api("/api/signal/open-in-murage", { method: "POST", body: JSON.stringify(payload) }, 0);
        store?.dispatch({ type: "toggleAppSettings", open: false });
        store?.dispatch({ type: "select", id: target.botId, threadId: target.threadId });
      }
    },
  }, [injected, store?.dispatch]);
  const [status, setStatus] = useState<ChannelState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), epoch = useRef(0), live = useRef(false);
  const [confirm, setConfirm] = useState<"disconnect" | "owner" | null>(null);
  const [reviewing, setReviewing] = useState(false), [position, setPosition] = useState(0);
  const [now, setNow] = useState(Date.now());
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!enabled) return;
    live.current = true;
    const refresh = async () => {
      if (lock.current) return;
      const version = epoch.current;
      try { const next = await client.status(); if (live.current && version === epoch.current && !lock.current) { setStatus(next); setError(previous => previous === "Signal settings could not be loaded. Try again." ? "" : previous); } }
      catch { if (live.current && version === epoch.current) setError("Signal settings could not be loaded. Try again."); }
    };
    void refresh(); const poll = setInterval(() => void refresh(), 2000), clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { live.current = false; epoch.current++; clearInterval(poll); clearInterval(clock); };
  }, [client, enabled]);
  useEffect(() => { if (reviewing) reviewHeading.current?.focus(); }, [reviewing]);
  if (!enabled) return null;
  const reviews = status && "reviews" in status ? status.reviews ?? [] : [];
  const review = reviews[Math.min(position, Math.max(0, reviews.length - 1))];
  const reviewCount = status && "reviewCount" in status ? status.reviewCount ?? reviews.length : 0;
  const blocked = status?.state === "blocked" ? status : null;
  const dataFolder = blocked?.scope === "data-dir";
  const problem = blocked ? blocked.preservation ? { line: signalKeptCopy(blocked.preservation),
    ...(blocked.preservation.canKeepBoth ? { label:"Keep both and link again",action:"keep-both-and-link" as const } : {}) } : dataFolder ? {
    line: blocked.reason === "storage-owner" ? "Murage's data folder is owned by another account. Move Murage's data folder in Settings, Storage."
      : "Murage's data folder is open to other accounts. Move Murage's data folder in Settings, Storage.",
    label: "Open Storage", action: "open-storage" as const,
  } : problemCopy[blocked.reason] : null;
  const run = async (action: Mutation | OpenAction, payload: Record<string, unknown> = {}) => {
    if (lock.current) return;
    lock.current = true; epoch.current++; setBusy(true); setError("");
    try {
      if (["open-in-murage", "show-folder", "open-storage", "check-for-updates"].includes(action)) await client.open(action as OpenAction, payload);
      else {
        const answer = await client.action(action as Mutation, payload);
        if (!live.current) return;
        setStatus(answer.status); setConfirm(null);
        if (answer.result === "full") setError("Signal is catching up. Try again in a minute.");
        if (answer.result === "too-early") setError("Signal is busy. Wait for the countdown, then try again.");
        if (answer.result === "not-resendable") setError("This reply cannot be sent again. Review it in Murage.");
      }
    } catch { if (live.current) setError("Signal could not finish that step. Try again."); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  const choose = (action: Mutation | OpenAction | "review") => {
    if (action === "review") { setReviewing(true); setPosition(0); setError(""); }
    else if (action === "disconnect") setConfirm("disconnect");
    else if (action === "connect-again" && blocked?.reason === "storage-owner") setConfirm("owner");
    else void run(action);
  };
  const control = (label: string, action: () => void, main = false, disabled = busy) => <button type="button" className={main ? primary : secondary} data-primary={main ? "true" : undefined} disabled={disabled} onClick={action}>{label}</button>;
  const cooldown = review?.state === "uncertain" && review.reason === "rate-limit" ? Math.max(0, review.resendAfter - now) : 0;
  return <section aria-labelledby="signal-settings-title" className="rounded-xl border border-hairline/40 bg-card p-4 space-y-3 text-[13px] text-ink">
    <h3 id="signal-settings-title" className="font-medium">Signal</h3>
    {!status && <><p role="status">Checking Signal…</p>{control("Try again", () => { void client.status().then(next => { setStatus(next); setError(previous => previous === "Signal settings could not be loaded. Try again." ? "" : previous); }).catch(() => setError("Signal settings could not be loaded. Try again.")); })}</>}
    {confirm ? <div role="group" aria-label={confirm === "owner" ? "Remove the old device" : "Disconnect Signal"} className="space-y-3">
      <p>{confirm === "owner" ? "In Signal on your phone, open Settings, Linked devices and remove Murage. Then connect again." : "Murage stops reading and answering in Signal and forgets this link."}</p>
      <div className="flex flex-wrap gap-2">{control(confirm === "owner" ? "I removed it" : "Disconnect Signal", () => void run(confirm === "owner" ? "connect-again" : "disconnect", confirm === "owner" ? { removedDeviceOnPhone: true } : {}), true)}
        {control("Cancel", () => setConfirm(null))}</div>
    </div> : reviewing && review ? <div className="space-y-3">
      <h4 ref={reviewHeading} tabIndex={-1} className="font-medium">Reply {Math.min(position + 1, reviews.length)} of {reviews.length}</h4>
      <p>{review.state === "needs-review" ? "Murage lost track of the answer to 1 Signal note." : review.state === "rejected" ? "This reply could not be sent to Signal." : review.reason === "rate-limit" ? "Signal was busy, so this reply may not have arrived." : "1 reply may not have reached Signal."}</p>
      {review.response && <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-sans">{review.response}</pre>}
      <div className="flex flex-wrap gap-2">
        {review.state === "uncertain" && review.response ? control("Send again", () => void run("resend", { deliveryId: review.deliveryId }), true, busy || cooldown > 0) : review.state === "needs-review" ? control("Open in Murage", () => void run("open-in-murage", { deliveryId: review.deliveryId }), true) : null}
        {control(review.state === "needs-review" ? "Dismiss" : "Leave it", () => void run(review.state === "needs-review" ? "dismiss" : "leave-it", { deliveryId: review.deliveryId }))}
        {reviews.length > 1 && control("Next reply", () => { setPosition((position + 1) % reviews.length); setError(""); })}
        {control("Back", () => { setReviewing(false); setError(""); })}
      </div>
      {review.state === "uncertain" && review.response && <p className="text-ink-secondary">{cooldown > 0 ? `Try again in ${Math.ceil(cooldown / 60000)} min. ` : ""}It may show twice in Signal.</p>}
    </div> : <>
      {status?.state === "not-linked" && <><p>Talk to your Chief from Note to Self in Signal.</p>{status.removeDeviceOnPhone && <p>Also remove Murage under Linked devices in Signal.</p>}{status.preservation?.canLink !== false && control("Connect Signal", () => choose("link"), true)}</>}
      {status?.state === "linking" && <>
        {status.expiresAt > now ? <QRCodeSVG value={status.uri} size={192} role="img" aria-label="Scan to connect Signal" /> : <p role="status">Getting a new code…</p>}
        <p>On your phone: Signal, Settings, Linked devices, +. Then scan this.</p>
        <p className="text-ink-secondary">Murage shows in your Signal as a linked device named Murage. Remove it there any time.</p>
        {control("Cancel", () => void run("disconnect"))}
      </>}
      {status?.state === "linked" && <><p>Connected as {status.maskedNumber}</p><p className="text-ink-secondary">Send yourself a text note in Signal and your Chief answers there. Pictures and voice notes come later.</p>
        {status.repairedStorageOwner && <p>If two Murage devices show on your phone, remove the older one.</p>}{control("Disconnect", () => choose("disconnect"))}</>}
      {problem && <><p>{blocked?.reason === "notes-stuck" && blocked.noteCount ? `Murage could not save ${blocked.noteCount} Signal ${blocked.noteCount === 1 ? "note" : "notes"}.` : problem.line}</p>
        {problem.label && problem.action && control(problem.label, () => choose(problem.action!), true)}
        {blocked?.path && !blocked.preservation && <p className="break-all text-ink-secondary">{blocked.reason === "storage-owner" && !dataFolder ? "Remove this folder, then try again: " : "Folder: "}{blocked.path}</p>}
        {blocked?.path && problem.action !== "show-folder" && !dataFolder && control("Show folder", () => choose("show-folder"))}</>}
      {status?.kept && <div className="space-y-2"><p>{status.state === "linked" && status.kept.kind === "earlier"
        ? "Murage also kept an earlier Signal link in your data folder. In Signal on your phone, open Settings, Linked devices and remove the older Murage entry."
        : status.state === "not-linked" && status.kept.kind === "moved"
        ? "Murage kept the earlier Signal files in your data folder. To use Signal here, link it again. Then remove the older Murage entry under Linked devices in Signal on your phone."
        : status.state === "not-linked" && status.kept.kind === "earlier"
        ? signalKeptCopy({progress:"ready",canLink:true,canKeepBoth:false})
        : "Murage also kept earlier Signal files in your data folder."}</p>{control("Show folder", () => choose("show-folder"))}</div>}
      {reviewCount > 0 && <div className="space-y-2"><p>{reviewCount >= 150 ? `${reviewCount} replies are waiting for your review in Signal settings.` : `${reviewCount} ${reviewCount === 1 ? "reply needs" : "replies need"} your review.`}</p>
        {problem?.action !== "review" && control("Review", () => choose("review"), !problem)}</div>}
    </>}
    {reviewing && !review && <p role="status">No replies are waiting for review.</p>}
    {error && <p role="alert">{error}</p>}
    <details className="text-ink-secondary"><summary className="cursor-pointer min-h-11 py-3">Signal limits</summary>
      <div className="space-y-2"><p>Only text in your own Note to Self gets an answer.</p>
        <p>If a note gets no answer after Murage restarts, send it again.</p>
        <p>Deleting a note in Signal keeps its conversation in Murage; delete it there too.</p>
        <p>On Windows, a sudden power loss may mean sending your last note again.</p>
      </div>
    </details>
  </section>;
}

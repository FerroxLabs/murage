// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { EMAIL_STATUS_EVENT } from "@/lib/email-status-event";
import { Card } from "./SettingsPrimitives";

const BASE = "/api/email/owner-signin";
const UNAVAILABLE = "Email connection is not available on this Cloud home yet.";
type Attempt = { requestId: string; state: string; userCode?: string; verificationUrl?: string };
export function CloudEmailSigninCard({ connected: initialConnected = false }: { connected?: boolean } = {}) {
  const [connected, setConnected] = useState(initialConnected);
  const [available, setAvailable] = useState(false), [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null), [note, setNote] = useState<string | null>(null);
  const starting = useRef(false), mounted = useRef(false);
  useEffect(() => {
    let readVersion = 0;
    let live = true, expiry: ReturnType<typeof setTimeout> | undefined;
    mounted.current = true;
    const read = async () => {
      const version = ++readVersion, requestedAt = performance.now();
      // Every report has a local deadline too, so a lost response cannot retain an old offer.
      try {
        const value = await api(BASE) as { available?: unknown; ttlMs?: unknown; connected?: boolean };
        if (live && version === readVersion) {
          const ttlMs = typeof value?.ttlMs === "number" && Number.isFinite(value.ttlMs) && value.ttlMs <= 30_000
            ? value.ttlMs - (performance.now() - requestedAt) : 0;
          if (typeof value.connected === "boolean") setConnected(value.connected);
          setAvailable(value?.available === true && ttlMs > 0);
          if (expiry) clearTimeout(expiry);
          expiry = setTimeout(() => { if (live) setAvailable(false); }, Math.max(0, ttlMs));
        }
      } catch { if (live && version === readVersion) setAvailable(false); }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 5_000);
    return () => { live = false; mounted.current = false; clearInterval(timer); if (expiry) clearTimeout(expiry); };
  }, []);
  useEffect(() => {
    if (!attempt || !["waiting", "code", "saving", "disconnecting"].includes(attempt.state)) return;
    let live = true;
    const timer = setInterval(() => {
      void api(`${BASE}/attempts/${encodeURIComponent(attempt.requestId)}`).then(value => {
        if (!live) return;
        const next = value as Attempt;
        setAttempt(next);
        if (!["waiting", "code", "saving", "disconnecting"].includes(next.state)) {
          starting.current = false; setBusy(false);
          setNote(next.state === "done" ? "Email account connected." : next.state === "unlinked" ? "Signed out of email." : "Email request ended. You can try again.");
          if (next.state === "unlinked") setConnected(false);
          if (next.state === "done") setConnected(true);
          if (["done", "unlinked"].includes(next.state)) window.dispatchEvent(new Event(EMAIL_STATUS_EVENT));
        }
      }).catch(() => { if (live) { starting.current = false; setBusy(false); setAttempt(null); setNote("Email request ended. You can try again."); } });
    }, 2_000);
    return () => { live = false; clearInterval(timer); };
  }, [attempt]);
  const start = async () => {
    if (starting.current || !available) return;
    starting.current = true; setBusy(true); setNote(null); setAttempt(null);
    try {
      const result = await api(`${BASE}/start`, { method: "POST", body: "{}" }) as Attempt;
      if (mounted.current) setAttempt(result);
    } catch {
      starting.current = false;
      if (mounted.current) { setBusy(false); setAvailable(false); setNote(UNAVAILABLE); }
    }
  };
  const signOut = async () => {
    if (starting.current || !connected) return;
    starting.current = true; setBusy(true); setNote("Signing out of email."); setAttempt(null);
    try {
      const result = await api(`${BASE}/sign-out`, { method: "POST", body: "{}" }) as Attempt;
      if (mounted.current) setAttempt(result);
    } catch {
      starting.current = false;
      if (mounted.current) { setBusy(false); setNote("Email sign-out ended. You can try again."); }
    }
  };
  let verificationUrl: string | null = null;
  try { const url = new URL(attempt?.verificationUrl ?? ""); if (url.protocol === "https:" && !url.username && !url.password) verificationUrl = url.href; } catch { /* No link until a code arrives. */ }
  const content = <div data-testid="cloud-email-signin">
      <p className="text-[13px] text-ink-secondary">{connected ? "Email account connected." : available ? "Connect your Flux Router account to set up bot email on this Cloud home." : UNAVAILABLE}</p>
      {!connected && available && <button type="button" className="mt-2 min-h-9 rounded-lg bg-control px-3 text-[13px] text-ink disabled:opacity-60" disabled={busy} onClick={() => void start()}>Connect email account</button>}
      {connected && <button type="button" className="mt-2 min-h-9 rounded-lg bg-control px-3 text-[13px] text-ink disabled:opacity-60" disabled={busy} onClick={() => void signOut()}>Sign out of email</button>}
      {attempt?.state === "waiting" && <p role="status">Getting your sign-in code.</p>}
      {attempt?.state === "code" && verificationUrl && <p role="status">Open <a href={verificationUrl} target="_blank" rel="noopener noreferrer" className="underline">Flux Router sign-in</a> and enter this code: <strong>{attempt.userCode}</strong>.</p>}
      {attempt?.state === "saving" && <p role="status">Saving your email connection.</p>}
      {note && <p role="status">{note}</p>}
    </div>;
  return initialConnected ? content : <Card title="Bot email">{content}</Card>;
}

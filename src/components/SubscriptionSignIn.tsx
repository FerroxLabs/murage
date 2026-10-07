// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Use a plan you already have": Sign in with ChatGPT and Sign in with Grok.
// Ported from Wayland's ChatGptButton.tsx and XGrokButton.tsx (the Grok paste
// box included). Lazy-loaded by ModelsSettings, so none of this reaches the
// first paint. No token ever reaches this component: main returns status and
// display fields only.
import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { PublicProviderConnection, SignInPreset } from "../../shared/provider-connections";
import type { SignInError, SignInProviderStatus } from "../../shared/model-signin";

const focus = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const button = `min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink disabled:opacity-50 ${focus}`;
const input = `min-h-11 min-w-0 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink ${focus}`;
const CONNECTION_ID: Record<SignInPreset, string> = { chatgpt: "signin-chatgpt", supergrok: "signin-grok" };
/** Reveal the Grok paste box only if the loopback has not finished (Wayland). */
const PASTE_DELAY_MS = 12_000;

const ERROR_KEY: Record<SignInError, LocaleKey> = {
  cancelled: "modelSignIn.error.cancelled", timeout: "modelSignIn.error.timeout", unauthorized: "modelSignIn.error.unauthorized",
  offline: "modelSignIn.error.offline", headless: "modelSignIn.error.headless", disabled: "modelSignIn.error.disabled",
  storage: "modelSignIn.error.storage", keyring: "modelSignIn.error.keyring", "desktop-only": "modelSignIn.error.desktopOnly", port: "modelSignIn.error.port",
  browser: "modelSignIn.error.browser", unknown: "modelSignIn.error.unknown",
};
const COPY: Record<SignInPreset, { button: LocaleKey; note: LocaleKey; ended: LocaleKey; unauthorized: LocaleKey }> = {
  chatgpt: { button: "modelSignIn.chatgpt.button", note: "modelSignIn.chatgpt.note", ended: "modelSignIn.chatgpt.ended", unauthorized: "modelSignIn.chatgpt.unauthorized" },
  supergrok: { button: "modelSignIn.grok.button", note: "modelSignIn.grok.note", ended: "modelSignIn.grok.ended", unauthorized: "modelSignIn.grok.unauthorized" },
};

export function errorLine(provider: SignInPreset, error: SignInError): string {
  return t(error === "unauthorized" ? COPY[provider].unauthorized : ERROR_KEY[error] ?? "modelSignIn.error.unknown");
}

/** Wait for the server to list the new sign-in, then fetch its model list. */
async function refreshAfterSignIn(provider: SignInPreset): Promise<void> {
  const id = CONNECTION_ID[provider];
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const snapshot: { connections: PublicProviderConnection[] } = await api("/api/provider-connections");
    if (snapshot.connections.some(connection => connection.id === id && connection.enabled)) {
      await api(`/api/provider-connections/${encodeURIComponent(id)}/refresh`, { method: "POST" });
      return;
    }
  }
}

export function ProviderRow({ status, connection, busy, onStart, onStartDevice, onSignOut, onCancel }: {
  status: SignInProviderStatus; connection?: PublicProviderConnection; busy: boolean;
  onStart: () => void; onStartDevice?: () => void; onSignOut: () => void; onCancel: () => void;
}) {
  const { provider } = status;
  const [showPaste, setShowPaste] = useState(false), [code, setCode] = useState(""), [codeError, setCodeError] = useState("");
  useEffect(() => {
    setShowPaste(false); setCode(""); setCodeError("");
    if (status.state !== "waiting" || !status.acceptsCode) return;
    const timer = setTimeout(() => setShowPaste(true), PASTE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status.state, status.acceptsCode]);
  const submit = async () => {
    const value = code.trim();
    if (!value) return;
    const accepted = await window.muragebox?.modelSignIn?.submitCode(provider, value).catch(() => false);
    if (!accepted) setCodeError(t("modelSignIn.codeRefused"));
  };
  const pausedUntil = connection?.signIn?.pausedUntil;
  const account = status.email ? t("modelSignIn.signedInAs", { email: status.email }) : t("modelSignIn.signedIn");
  return <div className="rounded-lg border border-hairline/40 p-3" data-signin-provider={provider}>
    {status.state === "connected" ? <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="break-words text-[13px] text-ink">{t(COPY[provider].button)} · {account}</p>
        {status.plan && <p className="text-[12px] text-ink-secondary">{t("modelSignIn.plan", { plan: status.plan.charAt(0).toUpperCase() + status.plan.slice(1) })}</p>}
      </div>
      <button type="button" className={button} disabled={busy} onClick={onSignOut}>{t("modelSignIn.signOut")}</button>
    </div> : status.state === "waiting" ? <div className="space-y-2">
      {status.device ? <div className="space-y-1" data-signin-device>
        <p role="status" className="text-[12px] text-ink-secondary">{t("modelSignIn.device.open")}</p>
        <p className="break-all text-[12px]"><a href={status.device.verificationUrl} target="_blank" rel="noreferrer noopener" className="underline">{status.device.verificationUrl}</a></p>
        <p className="text-[12px] text-ink-secondary">{t("modelSignIn.device.enter")}</p>
        <p className="select-all font-mono text-[20px] tracking-widest text-ink" aria-label={t("modelSignIn.device.codeLabel")}>{status.device.userCode}</p>
      </div> : <p role="status" className="text-[12px] text-ink-secondary">{t("modelSignIn.waiting")}</p>}
      {showPaste && <form className="space-y-2" onSubmit={event => { event.preventDefault(); void submit(); }}>
        <p role="status" className="text-[12px] text-ink-secondary">{t("modelSignIn.pasteHint")}</p>
        <div className="flex flex-wrap gap-2">
          <input value={code} onChange={event => { setCode(event.target.value); setCodeError(""); }} aria-label={t("modelSignIn.pastePlaceholder")} placeholder={t("modelSignIn.pastePlaceholder")} autoComplete="off" spellCheck={false} maxLength={4096} className={`${input} flex-1`} />
          <button type="submit" className={button} disabled={!code.trim()}>{t("modelSignIn.pasteSubmit")}</button>
        </div>
        {codeError && <p role="alert" className="text-[12px] text-danger">{codeError}</p>}
      </form>}
      <button type="button" className={button} onClick={onCancel} autoFocus>{t("modelSignIn.cancel")}</button>
    </div> : <div className="space-y-2">
      {status.state === "needs-sign-in" && <p role="alert" className="text-[12px] text-danger">{t(COPY[provider].ended)}</p>}
      <button type="button" className={`${button} w-full sm:w-auto`} disabled={busy} onClick={onStart}>{status.state === "needs-sign-in" ? t("modelSignIn.signInAgain") : t(COPY[provider].button)}</button>
      {onStartDevice && <button type="button" className={`${button} ml-0 w-full sm:ml-2 sm:w-auto`} disabled={busy} onClick={onStartDevice}>{t("modelSignIn.device.button")}</button>}
    </div>}
    {provider === "supergrok" && <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary"><span className="mr-1 rounded bg-control px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink">{t("modelSignIn.grok.unofficial")}</span>{t(COPY[provider].note)}</p>}
    {provider === "chatgpt" && <p className="mt-2 text-[11px] leading-relaxed text-ink-secondary">{t(COPY[provider].note)}</p>}
    {pausedUntil && status.state === "connected" && <p role="status" className="mt-2 text-[12px] text-warning">{t("modelSignIn.paused", { time: new Date(pausedUntil).toLocaleString() })}</p>}
  </div>;
}

export default function SubscriptionSignIn({ connections, onChanged }: { connections: readonly PublicProviderConnection[]; onChanged: () => void }) {
  const bridge = typeof window === "undefined" ? undefined : window.muragebox?.modelSignIn;
  const [providers, setProviders] = useState<SignInProviderStatus[] | null>(null);
  const [busy, setBusy] = useState<SignInPreset | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const mounted = useRef(true);
  const read = async () => {
    if (!bridge) return;
    try { const status = await bridge.status(); if (mounted.current) setProviders(status.providers); }
    catch { if (mounted.current) setMessage({ tone: "error", text: t("modelSignIn.error.unknown") }); }
  };
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; }; }, []);
  // A sign-in started before this page was opened (or in another window)
  // still finishes in the browser: follow it until it settles.
  const waitingElsewhere = busy === null && Boolean(providers?.some(status => status.state === "waiting"));
  useEffect(() => {
    if (!waitingElsewhere || !bridge) return;
    const before = new Set(providers?.filter(status => status.state === "waiting").map(status => status.provider));
    const timer = setInterval(() => {
      void bridge.status().then(status => {
        if (!mounted.current) return;
        setProviders(status.providers);
        for (const row of status.providers) if (before.has(row.provider) && row.state === "connected") { onChanged(); void refreshAfterSignIn(row.provider).catch(() => {}).then(onChanged); }
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [waitingElsewhere]);
  if (!bridge) return <section aria-labelledby="signin-heading" className="rounded-xl border border-hairline/40 p-4">
    <h3 id="signin-heading" className="text-[15px] font-medium text-ink">{t("modelSignIn.heading")}</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("modelSignIn.remote")}</p>
  </section>;
  const visible = (providers ?? []).filter(status => status.enabled);
  if (providers && !visible.length) return null;
  const start = async (provider: SignInPreset, device = false) => {
    setBusy(provider); setMessage(null);
    // show "waiting" right away; the promise resolves when the browser finishes
    setProviders(current => current?.map(status => status.provider === provider ? { ...status, state: "waiting", acceptsCode: !device && provider === "supergrok" } : status) ?? current);
    // A code sign-in has to show its code as soon as the vendor hands it over.
    const follow = device ? setInterval(() => { void read(); }, 1500) : undefined;
    try {
      const result = await (device ? bridge.startDevice(provider) : bridge.start(provider));
      if (!mounted.current) return;
      if (result.ok) {
        setMessage({ tone: "ok", text: t("modelSignIn.connected") });
        onChanged();
        await refreshAfterSignIn(provider).catch(() => {});
        onChanged();
      } else if (result.error !== "cancelled") setMessage({ tone: "error", text: errorLine(provider, result.error) });
    } catch { if (mounted.current) setMessage({ tone: "error", text: t("modelSignIn.error.unknown") }); }
    finally { if (follow) clearInterval(follow); if (mounted.current) { setBusy(null); await read(); } }
  };
  const signOut = async (provider: SignInPreset) => {
    setBusy(provider); setMessage(null);
    try {
      const result = await bridge.signOut(provider);
      if (!result.ok) setMessage({ tone: "error", text: "error" in result ? errorLine(provider, result.error) : t("modelSignIn.signOutFailed") });
      onChanged();
    } catch { setMessage({ tone: "error", text: t("modelSignIn.signOutFailed") }); }
    finally { if (mounted.current) { setBusy(null); await read(); } }
  };
  return <section aria-labelledby="signin-heading" className="rounded-xl border border-hairline/40 p-4">
    <h3 id="signin-heading" className="text-[15px] font-medium text-ink">{t("modelSignIn.heading")}</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("modelSignIn.note")}</p>
    <div className="mt-3 space-y-3">
      {visible.map(status => <ProviderRow key={status.provider} status={status} connection={connections.find(connection => connection.id === CONNECTION_ID[status.provider])}
        busy={busy !== null && busy !== status.provider || busy === status.provider && status.state !== "waiting"}
        onStart={() => void start(status.provider)} onStartDevice={() => void start(status.provider, true)} onSignOut={() => void signOut(status.provider)}
        onCancel={() => { void bridge.cancel(status.provider); }} />)}
    </div>
    {message && <p role={message.tone === "error" ? "alert" : "status"} className={`mt-3 text-[12px] ${message.tone === "error" ? "text-danger" : "text-success"}`}>{message.text}</p>}
  </section>;
}

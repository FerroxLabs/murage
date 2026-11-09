// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The sign-in dialog behind EngineSignInButton. It opens by a press and most people press it once, so it and the session it
// runs load on that press, not with the first paint (src/first-paint.test.ts). Opening starts nothing: it names the engine
// and the account folder, and only the press inside starts the engine's own login.
import { useNativeDialogLayer } from "@/lib/native-dialog-layer";
import type { LoadedLayerProps } from "@/components/LazyOverlay";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { TerminalSquare } from "lucide-react";

import { t } from "@/lib/i18n";
import { LOCAL_LOGIN_START, openLocalLogin, type LocalEngineLoginBridge, type LocalLoginSession, type LocalLoginState } from "@/lib/local-engine-login";
import type { LocaleKey } from "@/locales";
import { CommandLine, primary } from "./EngineSignInButton";
import { BOX_DIALOG, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";

const quiet = "rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

/** A translated line with one word set apart, so a language can put the word where its grammar wants it. */
function withPlaced(key: LocaleKey, name: string, word: ReactNode, params?: Record<string, string>): ReactNode {
  const [before, after = ""] = t(key, params).split(`{${name}}`);
  return <>{before}{word}{after}</>;
}

export type EngineSignInActions = Pick<LocalLoginSession, "open" | "openTerminal"> & { retry(): void };

const closedLine = (state: LocalLoginState, label: string): string => {
  if (state.result === "signed-in") return t("engineSignIn.signedIn", { label });
  if (state.message) return state.message;
  if (state.result === "not-finished") return t("engineSignIn.notFinished");
  if (state.result === "stopped") return t("engineSignIn.stopped");
  return t("engineSignIn.failed");
};

/** Terminal as the way on, with its progress. */
function TerminalPress({ state, primaryPress, actions }: { state: LocalLoginState; primaryPress: boolean; actions: EngineSignInActions }) {
  return <>
    <div><button type="button" data-engine-signin-terminal className={primaryPress ? primary : quiet} disabled={state.terminal === "opening"} onClick={() => void actions.openTerminal()}>{primaryPress ? <TerminalSquare size={14} aria-hidden /> : null}{state.terminal === "opening" ? t("setup.openingTerminal") : primaryPress ? t("setup.openSignIn") : t("engineSignIn.useTerminal")}</button></div>
    {state.terminal === "failed" && state.phase !== "closed" ? <p role="alert" className="text-danger">{state.message || t("engineSignIn.terminal.failed")}</p> : null}
  </>;
}

/** What the dialog shows for a state. No hooks on the session: every kind can be drawn and tested from a state alone. */
export function EngineSignInBody({ state, name, command, actions }: { state: LocalLoginState; name: string; command?: string; actions: EngineSignInActions }) {
  const label = state.label || name;
  const box = "flex min-w-0 flex-col gap-3 text-[13px] text-ink";
  if (state.phase === "refused") {
    return (
      <div className={box}>
        <p role="status" className="min-w-0 break-words">{state.message || t("engineSignIn.startFailed")}</p>
        <div><button type="button" data-engine-signin-retry className={primary} onClick={actions.retry}>{t("engineSignIn.tryAgain")}</button></div>
      </div>
    );
  }
  if (state.phase === "loading") return <p role="status" className="text-[13px] text-ink-secondary">{t("engineSignIn.gettingReady", { label })}</p>;
  if (state.phase === "closed") {
    return (
      <div className={box}>
        <p role="status" className="min-w-0 break-words">{closedLine(state, label)}</p>
        {state.result === "not-finished" || state.result === "failed" ? (state.kind === "none" ? null : <TerminalPress state={state} primaryPress={false} actions={actions} />) : null}
      </div>
    );
  }
  if (state.terminal === "opened") return <div className={box}><p role="status">{t("engineSignIn.terminal.opened", { label })}</p></div>;
  if (state.phase === "finishing") return <div className={box}><p role="status">{t("engineSignIn.finishing")}</p></div>;
  if (state.phase === "waiting") {
    return (
      <div className={box}>
        <p role="status">{t("engineSignIn.waitingBrowser")}</p>
        {state.slow || state.terminal !== "idle" ? <TerminalPress state={state} primaryPress={false} actions={actions} /> : null}
      </div>
    );
  }
  const account = state.accountRoot ? <p data-signin-account className="min-w-0 text-[13px] text-ink-secondary">{withPlaced("engineSignIn.desktop.account", "folder", <code className="break-all text-ink">{state.accountRoot}</code>, { label })}</p> : null;
  if (state.kind === "headless") {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {account}
        <div><button type="button" data-engine-signin-open className={primary} onClick={() => void actions.open()}>{t("engineSignIn.openSignIn")}</button></div>
      </div>
    );
  }
  if (state.kind === "terminal") {
    return (
      <div className={box}>
        {account}
        <p role="status">{t("engineSignIn.terminal.line", { label })}</p>
        <TerminalPress state={state} primaryPress actions={actions} />
      </div>
    );
  }
  return (
    <div className={box}>
      <p role="status">{t("engineSignIn.none", { label })}</p>
      {command ? <CommandLine command={command} name={label} /> : null}
    </div>
  );
}

export function EngineSignInDialog({ layerLifecycle, bridge, instanceId, name, command, onClose: requestedClose }: { bridge: LocalEngineLoginBridge; instanceId: string; name: string; command?: string; onClose(): void } & { layerLifecycle?: LoadedLayerProps }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const native = useNativeDialogLayer(dialog, { name: "engine-sign-in", returnFocusTo: layerLifecycle?.opener, lease: layerLifecycle?.lease });
  const onClose = () => native.dismiss(requestedClose);
  const session = useRef<LocalLoginSession | null>(null);
  const [state, setState] = useState<LocalLoginState>(LOCAL_LOGIN_START);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { native.show(); }, []);
  useEffect(() => {
    // StrictMode mounts, unmounts and mounts again: opening reads a preview and starts nothing, so a second read costs nothing.
    const current = openLocalLogin({ bridge, instanceId, onState: setState });
    session.current = current;
    return () => { current.stop(); session.current = null; };
  }, [bridge, instanceId, attempt]);
  const actions: EngineSignInActions = {
    open: async () => { await session.current?.open(); },
    openTerminal: async () => { await session.current?.openTerminal(); },
    retry: () => { setState(LOCAL_LOGIN_START); setAttempt((current) => current + 1); },
  };
  const live = state.phase === "waiting" || state.phase === "finishing";
  return <dialog ref={dialog} aria-label={t("engineSignIn.title", { label: state.label || name })} data-engine-signin-dialog onCancel={onClose} onClose={() => { if (!dialog.current?.open) onClose(); }}
    className={`${BOX_DIALOG} m-auto w-[min(480px,calc(100vw-24px))] rounded-2xl border border-hairline bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60`}>
    <BoxHead className="border-b border-hairline/40 px-4 py-3"><h2 className="min-w-0 break-words text-[15px] font-semibold">{t("engineSignIn.title", { label: state.label || name })}</h2></BoxHead>
    <BoxBody className="p-4"><EngineSignInBody state={state} name={name} command={command} actions={actions} /></BoxBody>
    <BoxFoot className="border-t border-hairline/40 px-4 py-3"><button type="button" className={quiet} onClick={onClose}>{live ? t("engineSignIn.cancel") : t("engineSignIn.close")}</button></BoxFoot>
  </dialog>;
}

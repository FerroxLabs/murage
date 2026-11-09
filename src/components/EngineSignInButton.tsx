// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { LazyOverlay } from "@/components/LazyOverlay";
//
// The one sign-in button for an engine on this computer, on every surface: Inbox, EngineSetup (Settings, NoEngines, the
// failed turn, the model picker) and the first-run card. Pressing it opens the dialog, which starts nothing: it names the
// engine and the account folder. The press inside the dialog starts the engine's own login, and the engine opens the
// browser (design ENGINE-SIGNIN-SIMPLE-1014.md, Part B). The dialog loads on that press (EngineSignInDialog.tsx).
//
// The bridge is built by Part A in Electron main. A window without it (a browser or a phone) shows the plain line. A Cloud
// home keeps the command it always showed here: its own sign-in screens replace that on the Cloud lane.
import { useCallback, useRef, useState } from "react";
import { LogIn } from "lucide-react";

import { useCopyFeedback } from "@/lib/copy-text";
import { currentLocalEngineLogin, engineSignInSurface } from "@/lib/engine-signin-surface";
import { t } from "@/lib/i18n";
import type { LocalEngineLoginBridge } from "@/lib/local-engine-login";
import { retryableLazy } from "./LazyBoundary";

const Dialog = retryableLazy(() => import("./EngineSignInDialog").then((module) => ({ default: module.EngineSignInDialog })));
const EngineSignInDialog = Dialog.Component;

export const primary = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export const secondaryButton = "inline-flex items-center justify-center gap-2 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

/** A command the person can copy. Only where Murage cannot run the sign-in itself, never on the default path. */
export function CommandLine({ command, name }: { command: string; name: string }) {
  const { mark, copy } = useCopyFeedback();
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-control py-1 pl-3 pr-1">
      <code className="min-w-0 flex-1 break-all text-[12px] text-ink">{command}</code>
      <button type="button" className="min-h-8 shrink-0 rounded-md px-2 text-[12px] text-ink-secondary hover:bg-raised-hover hover:text-ink" aria-label={t("engineSignIn.copyCommand", { name })} onClick={() => void copy(command)}>
        {mark === "copied" ? t("common.copied") : mark === "failed" ? t("engineSignIn.copyFailed") : t("common.copy")}
      </button>
    </div>
  );
}

export function EngineSignInButton({ instanceId, name, command, className, onDone, quiet = false, secondary = false, bridge = currentLocalEngineLogin() }: {
  instanceId: string;
  /** 1.0.14 F0: on a wall where "Use Fuigo instead" is the primary button, signing in is the secondary one. */
  quiet?: boolean;
  name: string;
  /** The driver's command: shown only where Murage cannot start the sign-in itself. */
  command?: string;
  className?: string;
  /** The dialog closed, however it ended: the surface re-reads what it shows. */
  onDone?(): void;
  /** Drawn as the second action, where "Use Fuigo instead" is the main one (Fuigo front and center, 1.0.14). */
  secondary?: boolean;
  /** Test seam; defaults to the desktop bridge. */
  bridge?: LocalEngineLoginBridge | null;
}) {
  const [open, setOpen] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  const close = useCallback(() => { setOpen(false); done.current?.(); }, []);
  const surface = engineSignInSurface(bridge, typeof document === "undefined" ? undefined : document);
  if (surface === "cloud-home") return command ? <div className={className}><CommandLine command={command} name={name} /></div> : null;
  if (surface === "elsewhere" || !bridge) return <p role="status" className={`text-[12.5px] text-ink-secondary ${className ?? ""}`}>{t("engineSignIn.elsewhere")}</p>;
  return (
    <div className={className}>
      <button type="button" data-engine-signin-button className={secondary || quiet ? secondaryButton : primary} onClick={() => setOpen(true)}><LogIn size={14} aria-hidden />{t("engineSignIn.button", { name })}</button>
      {open ? <LazyOverlay name="engine-sign-in-load" kind="dialog" covers="while-loading" onRetry={Dialog.retry} onDismiss={close}>{loadedLayer => (<EngineSignInDialog layerLifecycle={loadedLayer} bridge={bridge} instanceId={instanceId} name={name} command={command} onClose={loadedLayer.dismiss} />)}</LazyOverlay> : null}
    </div>
  );
}

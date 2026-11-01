// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The button a chat link becomes (ENGINE-SIGNIN-SIMPLE-1014). A press shows a dialog or a Settings page and nothing else:
// only the press inside the dialog starts anything. The press hands the link to one host in App, because a reply's bubble
// is replaced when it stops streaming and a row can leave the transcript, and a dialog in there would close with it.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { engineChatLinkStep, parseEngineChatLink, type EngineChatLinkStep } from "@/lib/engine-chat-link";
import { t } from "@/lib/i18n";
import { currentLocalEngineLogin, engineSignInSurface, type LocalEngineLoginBridge } from "@/lib/local-engine-login";
import { useStore, type InstanceInfo } from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { EngineSignInDialog } from "./EngineSignInButton";
import { BOX_DIALOG, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";

export const OPEN_ENGINE_CHAT_LINK_EVENT = "murage:engine-chat-link";

const button = "mx-0.5 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1 align-baseline text-[13px] font-semibold text-white hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const quiet = "rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

/** A button, never an href. A window that cannot run a sign-in (a phone, a browser, a Cloud home) gets the plain line. */
export function EngineChatLink({ href, children, bridge = currentLocalEngineLogin() }: {
  href: string;
  children?: ReactNode;
  /** Test seam; defaults to the desktop bridge. */
  bridge?: LocalEngineLoginBridge | null;
}) {
  const link = parseEngineChatLink(href);
  if (!link) return null;
  if (engineSignInSurface(bridge, typeof document === "undefined" ? undefined : document) !== "desktop") {
    return <span role="status" data-engine-chat-link-elsewhere className="text-ink-secondary">{t("engineSignIn.elsewhere")}</span>;
  }
  return <button type="button" data-engine-chat-link={link.kind} className={button} onClick={() => window.dispatchEvent(new CustomEvent(OPEN_ENGINE_CHAT_LINK_EVENT, { detail: href }))}>
    {children}
    {link.kind === "plan" && link.provider === "supergrok" ? <span className="rounded bg-black/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">{t("modelSignIn.grok.unofficial")}</span> : null}
  </button>;
}

function LinkDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} aria-label={title} data-engine-chat-link-dialog onCancel={onClose} onClose={onClose}
    className={`${BOX_DIALOG} m-auto w-[min(480px,calc(100vw-24px))] rounded-2xl border border-hairline bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60`}>
    <BoxHead className="border-b border-hairline/40 px-4 py-3"><h2 className="min-w-0 break-words text-[15px] font-semibold">{title}</h2></BoxHead>
    <BoxBody className="p-4">{children}</BoxBody>
    <BoxFoot className="border-t border-hairline/40 px-4 py-3"><button type="button" className={quiet} onClick={onClose}>{t("engineSignIn.close")}</button></BoxFoot>
  </dialog>;
}

/** What one press shows for one instance. */
export function EngineChatLinkDialog({ show, instance, bridge, onClose }: { show: "sign-in" | "signed-in" | "set-up"; instance: InstanceInfo; bridge: LocalEngineLoginBridge; onClose(): void }) {
  const name = instance.displayName;
  if (show === "sign-in") return <EngineSignInDialog bridge={bridge} instanceId={instance.instanceId} name={name} command={instance.install?.signInCommand} onClose={onClose} />;
  if (show === "signed-in") return <LinkDialog title={t("engineSignIn.title", { label: name })} onClose={onClose}><p role="status" className="text-[13px] text-ink">{t("engineChatLink.signedIn", { name })}</p></LinkDialog>;
  return <LinkDialog title={t("engineChatLink.setUpTitle", { name })} onClose={onClose}><EngineSetup instance={instance} setUp /></LinkDialog>;
}

/** Mounted once in App. Takes the press, reads the instances, shows the one thing the press asks for. */
export function EngineChatLinkHost() {
  const { state, dispatch, refreshInstances } = useStore();
  const instances = useRef(state.instances);
  instances.current = state.instances;
  const [shown, setShown] = useState<Extract<EngineChatLinkStep, { instanceId: string }> | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const link = parseEngineChatLink((event as CustomEvent<unknown>).detail);
      if (!link) return;
      const step = engineChatLinkStep(link, instances.current);
      if (step.show !== "settings") setShown(step);
      else dispatch({ type: "toggleAppSettings", open: true, section: step.section, ...("anchor" in step ? { anchor: step.anchor } : {}) });
    };
    window.addEventListener(OPEN_ENGINE_CHAT_LINK_EVENT, open);
    return () => window.removeEventListener(OPEN_ENGINE_CHAT_LINK_EVENT, open);
  }, [dispatch]);
  const close = useCallback(() => { setShown(null); void refreshInstances().catch(() => {}); }, [refreshInstances]);
  const instance = shown ? state.instances.find((candidate) => candidate.instanceId === shown.instanceId) : undefined;
  const bridge = currentLocalEngineLogin();
  if (!shown || !instance || !bridge) return null;
  return <EngineChatLinkDialog show={shown.show} instance={instance} bridge={bridge} onClose={close} />;
}

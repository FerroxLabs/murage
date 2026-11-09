// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a press on a chat link shows (ENGINE-SIGNIN-SIMPLE-1014). It loads on the first press, not with the first paint
// (src/first-paint.test.ts). Showing is all it does: only the press inside the dialog starts anything.
import { useNativeDialogLayer } from "@/lib/native-dialog-layer";
import type { LoadedLayerProps } from "@/components/LazyOverlay";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { engineChatLinkStep, parseEngineChatLink, type EngineChatLinkStep } from "@/lib/engine-chat-link";
import { currentLocalEngineLogin } from "@/lib/engine-signin-surface";
import { t } from "@/lib/i18n";
import type { LocalEngineLoginBridge } from "@/lib/local-engine-login";
import { useStore, type InstanceInfo } from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { EngineSignInDialog } from "./EngineSignInDialog";
import { BOX_DIALOG, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";

const quiet = "rounded-md bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

function LinkDialog({ layerLifecycle, title, onClose: requestedClose, children }: { title: string; onClose(): void; children: ReactNode } & { layerLifecycle?: LoadedLayerProps }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const native = useNativeDialogLayer(dialog, { name: "engine-chat-link", returnFocusTo: layerLifecycle?.opener, lease: layerLifecycle?.lease });
  const onClose = () => native.dismiss(requestedClose);
  useEffect(() => { native.show(); }, []);
  return <dialog ref={dialog} aria-label={title} data-engine-chat-link-dialog onCancel={onClose} onClose={() => { if (!dialog.current?.open) onClose(); }}
    className={`${BOX_DIALOG} m-auto w-[min(480px,calc(100vw-24px))] rounded-2xl border border-hairline bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60`}>
    <BoxHead className="border-b border-hairline/40 px-4 py-3"><h2 className="min-w-0 break-words text-[15px] font-semibold">{title}</h2></BoxHead>
    <BoxBody className="p-4">{children}</BoxBody>
    <BoxFoot className="border-t border-hairline/40 px-4 py-3"><button type="button" className={quiet} onClick={onClose}>{t("engineSignIn.close")}</button></BoxFoot>
  </dialog>;
}

/** What one press shows for one instance. */
export function EngineChatLinkDialog({ layerLifecycle, show, instance, bridge, onClose }: { show: "sign-in" | "signed-in" | "set-up"; instance: InstanceInfo; bridge: LocalEngineLoginBridge; onClose(): void } & { layerLifecycle?: LoadedLayerProps }) {
  const name = instance.displayName;
  if (show === "sign-in") return <EngineSignInDialog layerLifecycle={layerLifecycle} bridge={bridge} instanceId={instance.instanceId} name={name} command={instance.install?.signInCommand} onClose={onClose} />;
  if (show === "signed-in") return <LinkDialog layerLifecycle={layerLifecycle} title={t("engineSignIn.title", { label: name })} onClose={onClose}><p role="status" className="text-[13px] text-ink">{t("engineChatLink.signedIn", { name })}</p></LinkDialog>;
  return <LinkDialog layerLifecycle={layerLifecycle} title={t("engineChatLink.setUpTitle", { name })} onClose={onClose}><EngineSetup instance={instance} setUp /></LinkDialog>;
}

/** Reads the instances for a press and shows the one thing it asks for. */
export function EngineChatLinkPress({ layerLifecycle, onClose, press }: { press: { href: string } } & { layerLifecycle?: LoadedLayerProps; onClose?: () => void }) {
  const { state, dispatch, refreshInstances } = useStore();
  const instances = useRef(state.instances);
  instances.current = state.instances;
  const [shown, setShown] = useState<Extract<EngineChatLinkStep, { instanceId: string }> | null>(null);
  useEffect(() => {
    const link = parseEngineChatLink(press.href);
    if (!link) return;
    const step = engineChatLinkStep(link, instances.current);
    if (step.show !== "settings") setShown(step);
    else dispatch({ type: "toggleAppSettings", open: true, section: step.section, ...("anchor" in step ? { anchor: step.anchor } : {}) });
  }, [press, dispatch]);
  const close = useCallback(() => { setShown(null); onClose?.(); void refreshInstances().catch(() => { /* a re-read after the dialog closed; the dialog already said how it ended, and the last list stays */ }); }, [refreshInstances, onClose]);
  const instance = shown ? state.instances.find((candidate) => candidate.instanceId === shown.instanceId) : undefined;
  const bridge = currentLocalEngineLogin();
  if (!shown || !instance || !bridge) return null;
  return <EngineChatLinkDialog layerLifecycle={layerLifecycle} show={shown.show} instance={instance} bridge={bridge} onClose={close} />;
}

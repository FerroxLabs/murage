// SPDX-License-Identifier: AGPL-3.0-or-later
// An opaque notification target is resolved only through the authenticated owner route.
import { useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { useDesktopSurface } from "@/lib/use-surface";
import { openExternalPage } from "@/lib/open-external";
import { ConnectLabelForm } from "./ConnectLabelForm";
import type { ConfirmedConnectLabel } from "@/lib/connect-app";
import { useNativeDialogLayer } from "@/lib/native-dialog-layer";
import { BOX_DIALOG, BoxHead, BoxBody } from "./ui/BoxShell";
import { cn } from "@/lib/cn";

type Incident = { slug: string; label: string; accounts: Array<{ id: string; alias?: string }> };
export function ConnectorReconnectDialog({ incidentId }: { incidentId: string }) {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  const [incident, setIncident] = useState<Incident | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const native = useNativeDialogLayer(dialog, { name: "connector-reconnect" });
  const close = () => native.dismiss(() => dispatch({ type: "openConnectorReconnect" }));
  useEffect(() => { if (incident) native.show(); }, [incident]);
  useEffect(() => {
    let alive = true;
    void api(`/api/connector-incidents/${encodeURIComponent(incidentId)}`).then(value => { if (alive) setIncident(value); }).catch(() => { if (alive) dispatch({ type: "openConnectorReconnect" }); });
    return () => { alive = false; };
  }, [incidentId, dispatch]);
  const connect = async (accountId: string, alias: ConfirmedConnectLabel) => {
    setBusy(true); setProblem(null);
    try {
      const answer = await api(`/api/connector-incidents/${encodeURIComponent(incidentId)}`, { method: "POST", body: JSON.stringify({ accountId, alias }) });
      setPendingUrl(answer.url);
      await openExternalPage(answer.url, t("modelSignIn.error.browser"));
      close();
    } catch { setProblem(t("modelSignIn.error.browser")); }
    finally { setBusy(false); }
  };
  if (!incident) return null;
  const custom = incident.slug.startsWith("mcp-");
  return <dialog ref={dialog} aria-labelledby="connector-reconnect-title" onCancel={close} onClose={() => { if (!dialog.current?.open) close(); }} className={cn(BOX_DIALOG, "m-auto max-h-[90dvh] w-[min(28rem,calc(100vw-2rem))] rounded-xl bg-app text-ink shadow-xl backdrop:bg-black/40")}>
      <BoxHead className="p-5">
        <h2 id="connector-reconnect-title" className="font-medium">{t("connectorHealth.signIn", { connector: incident.label })}</h2>
        <button type="button" onClick={close}>{t("engineSignIn.close")}</button>
      </BoxHead>
      <BoxBody className="px-5 pb-5">
      {custom ? <>
        {desktop === true ? <button autoFocus type="button" onClick={() => { close(); dispatch({ type: "togglePlugins", open: true, surface: "mcp", reconnect: { slug: incident.slug } }); }}>{t("connectorHealth.reconnect")}</button>
          : <p>{t("connectorHealth.computer")}</p>}
        <button type="button" className="ml-4" onClick={close}>{t("engineSignIn.close")}</button>
      </> : incident.accounts.map(account => <ConnectLabelForm key={account.id} id={`reconnect-${account.id}`} service={incident.label} initial={account.alias ?? ""} busy={busy}
        onConfirm={alias => { void connect(account.id, alias); }} onCancel={close} />)}
      {pendingUrl && <button type="button" onClick={() => { void openExternalPage(pendingUrl, t("modelSignIn.error.browser")).then(close).catch(() => setProblem(t("modelSignIn.error.browser"))); }}>{t("connectorHealth.reconnect")}</button>}
      {problem && <p role="alert" className="mt-3 text-danger">{problem}</p>}
    {!custom && !incident.accounts.length && <button type="button" onClick={close}>{t("engineSignIn.close")}</button>}
      </BoxBody>
  </dialog>;
}

import { useState } from "react";
import { t } from "@/lib/i18n";
import { readEmailStatus, useEmailStatus, type EmailStatusState } from "@/lib/bot-email";
import { useStore } from "@/state/store";
import { EMAIL_OWNER_COPY, EMAIL_STATUS_COPY } from "../../../../shared/email-copy";
import { emailGate } from "../../BotEmailSettings";
import { Card } from "../../SettingsPrimitives";
import { chiefName, ComputerOnlyStub, SETTINGS_STUB_COPY } from "../../SettingsStub";

/** The existing status endpoint and session cache are shared with the desktop account card. */
export function BotEmailReadout() {
  const { state } = useStore();
  const status = useEmailStatus();
  const [fresh, setFresh] = useState<EmailStatusState | null>(null);
  const [busy, setBusy] = useState(false);
  // A later event read supersedes a manual refresh; neither mounts a second account store.
  const [readAtRefresh, setReadAtRefresh] = useState(status);
  const flux = state.config?.flux;
  return <BotEmailReadoutView status={fresh && readAtRefresh === status ? fresh : status}
    fluxReady={state.config == null ? undefined : flux?.configured === true && (flux.keyState === undefined || flux.keyState === "ok")}
    chief={chiefName(state.bots)} busy={busy} onRefresh={() => {
      if (busy) return;
      setBusy(true);
      setReadAtRefresh(status);
      void readEmailStatus().then(setFresh).finally(() => setBusy(false));
    }} />;
}

export function BotEmailReadoutView({ status, fluxReady, chief, busy = false, onRefresh }: {
  status: EmailStatusState; fluxReady: boolean | undefined; chief: string; busy?: boolean; onRefresh?: () => void;
}) {
  const gate = emailGate(status, fluxReady);
  const view = status.kind === "on" ? status.view : null;
  const line = status.kind === "checking" ? status.note ?? EMAIL_STATUS_COPY.checking
    : gate === "checking" ? SETTINGS_STUB_COPY.checking(SETTINGS_STUB_COPY.botEmail)
      : gate === "could-not-check" ? SETTINGS_STUB_COPY.couldNotCheck(SETTINGS_STUB_COPY.botEmail)
        : "line" in status ? status.line
          : gate === "not-yet" ? SETTINGS_STUB_COPY.notYet : SETTINGS_STUB_COPY.needsAccount(chief);
  return <>
    <Card title={EMAIL_OWNER_COPY.sectionTitle}>
      <div data-testid="bot-email-readout" className="space-y-2 break-words text-[13px] text-ink-secondary">
        <p>{view ? (view.accountState === "active" || view.accountState === "on" ? EMAIL_OWNER_COPY.accountOnLine : EMAIL_OWNER_COPY.accountOffLine) : line}</p>
        {view?.staleNote && <p>{view.staleNote}</p>}
        {view?.ownerKeyLine && <p>{view.ownerKeyLine}</p>}
        {view?.reasonLine && <p>{view.reasonLine}</p>}
        {view?.accountSends && <p>{EMAIL_OWNER_COPY.accountSentToday(view.accountSends.today, view.accountSends.perDay)}</p>}
        {view?.removing.map((item) => <p key={item.botId}>{EMAIL_OWNER_COPY.removingLine(item.address ?? item.botId)}</p>)}
        {view?.otherSetups?.length ? <div><p>{EMAIL_OWNER_COPY.otherSetupsTitle}</p>
          {view.otherSetups.map((item) => <p key={item.inboxId}>{item.address ?? item.inboxId}</p>)}
        </div> : null}
        <button type="button" data-bot-email-refresh disabled={busy} onClick={onRefresh}
          className="min-h-11 rounded-lg px-3 text-ink hover:bg-control disabled:opacity-50">{t("workspacePane.refresh")}</button>
      </div>
    </Card>
    <ComputerOnlyStub anchor="bot-email-heading" />
  </>;
}

// M6 setting card (owner: M6 lane). designs/settings-chat-1023/DESIGN.md sections 2 and 4.
// The bot's reason is drawn as the bot's own words; the label, path, scope and control are Murage's. An inline control is the
// page's own exported ChatControl (one renderer per control); without one the card offers Open in Settings only.
import { useCallback, useState, type ComponentType } from "react";
import { CARD_COPY, controlState, openSettingsAddressFor, sendTap, type CardView, type TapRequest, type TapState } from "@/lib/settings-chat";

export interface ChatControlProps { value: unknown; disabled: boolean; onChange: (value: unknown) => void }
/** Page controls exported for chat, by the name the catalog entry names. Each page's owner registers its own. */
export const CHAT_CONTROLS: Record<string, ComponentType<ChatControlProps>> = {};

export interface SettingCardProps {
  view: CardView;
  botName: string;
  /** Opens a Settings address (find L1). Navigation only. */
  openAddress: (address: string) => void;
  onSettled?: (state: TapState) => void;
  fetchImpl?: typeof fetch;
}

export function SettingCard({ view, botName, openAddress, onSettled, fetchImpl }: SettingCardProps) {
  const [tap, setTap] = useState<TapState | null>(null);
  const [applying, setApplying] = useState(false);
  const control = controlState(view, botName);
  const Control = view.control === "inline" && view.chatControl ? CHAT_CONTROLS[view.chatControl] : undefined;
  const scope = view.card.settingBot ? "bot" : "app";
  // a new pick is a new change against the view drawn now; only Try again reuses the CHECKING changeId, and it re-sends that
  // change's own request (value, expect, cardGen), never the redrawn view's, so the original value fence still holds
  const send = useCallback(async (request: TapRequest, changeId?: string) => {
    setApplying(true);
    const next = await sendTap(view.card.cardId, { ...request, changeId }, { fetch: (fetchImpl ?? fetch) as never, botName });
    setApplying(false);
    setTap(next);
    onSettled?.(next);
  }, [view.card.cardId, botName, fetchImpl, onSettled]);
  const settled = view.card.state === "SETTLED";
  return (
    <section data-setting-card={view.card.cardId} aria-label={view.label} className="my-2 max-w-md rounded-xl border border-hairline/60 bg-inset p-3 text-[13px]">
      {view.card.reason ? <p className="mb-2 text-ink-secondary"><span className="font-medium text-ink">{botName}: </span>{view.card.reason}</p> : null}
      <div className="font-medium text-ink">{view.label}</div>
      <div className="text-ink-secondary">{view.path}</div>
      <div className="mb-2 text-ink-secondary">{view.scopeLine}</div>
      {settled ? (
        <p role="status">{view.card.outcome === "superseded" ? CARD_COPY.superseded : view.card.outcome === "changed" ? CARD_COPY.changed : view.card.outcome === "withdrawn" ? CARD_COPY.withdrawn : CARD_COPY.dismissed}</p>
      ) : Control ? (
        <Control value={view.value} disabled={!control.enabled || applying || tap?.kind === "checking"} onChange={value => void send({ value, expect: view.expect, cardGen: view.card.cardGen })} />
      ) : (
        <button type="button" className="min-h-10 rounded-lg bg-control px-3" onClick={() => openAddress(openSettingsAddressFor(view, scope))}>{CARD_COPY.openInSettings}</button>
      )}
      {!settled && (tap && tap.kind !== "settled" ? <p role="status" className="mt-2">{tap.line}</p> : control.line ? <p className="mt-2 text-ink-secondary">{control.line}</p> : null)}
      {!settled && tap?.kind === "checking" ? <button type="button" className="mt-2 min-h-10 rounded-lg bg-control px-3" onClick={() => void send(tap.request, tap.changeId)}>{CARD_COPY.tryAgain}</button> : null}
      {!settled ? <button type="button" className="ml-2 mt-2 min-h-10 rounded-lg px-3 text-ink-secondary" onClick={() => void (fetchImpl ?? fetch)(`/api/settings-chat/cards/${encodeURIComponent(view.card.cardId)}/dismiss`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })}>{CARD_COPY.notNow}</button> : null}
    </section>
  );
}

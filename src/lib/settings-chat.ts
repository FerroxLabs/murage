// M6 client (owner: M6 lane). designs/settings-chat-1023/DESIGN.md section 4: APPLYING and CHECKING live only here.
// One changeId per tap, kept across every retry, so a lost 200 replays instead of writing twice or saying "nothing changed".
import type { ApplyRefusal, SettingCardRecord, SettingCardView } from "../../shared/settings-chat";
import { settingsAddressFor } from "./settings-address";

export type CardView = SettingCardView & { busy: boolean };
export type TapState =
  | { kind: "settled"; card: SettingCardRecord }
  | { kind: "open"; card?: SettingCardRecord; line: string; code?: ApplyRefusal; live?: unknown; redrawOpen?: boolean }
  /** `request` is the exact body the CHECKING change was sent with; Try again re-sends it unchanged (Astra 1fbb27906d). */
  | { kind: "checking"; changeId: string; line: string; request: TapRequest };
export interface TapRequest { value: unknown; expect: unknown; cardGen: number }

export const COULD_NOT_CHECK_LINE = "Could not check. Try again";
export const CHANGED_ELSEWHERE_LINE = "Changed elsewhere; nothing changed";
export const NEWER_CARD_LINE = "See the newer card below";
/** Card copy. Kept here until the settings.chat.* block passes the locale pack and copy-review pipeline (i18n owner). */
export const CARD_COPY = {
  openInSettings: "Open in Settings",
  changed: "Changed. You can set it back in Changed recently.",
  superseded: "See the newer card below.",
  withdrawn: "This setting can no longer be changed here.",
  dismissed: "Not now.",
  tryAgain: "Try again",
  notNow: "Not now",
} as const;

/** Plain card copy for the writer sentences the card can meet (Fable r2 L2); unknown sentences pass through. */
export function plainWriterLine(error: string, botName: string): string {
  if (/stop it before changing models|Stop this thread before changing/i.test(error)) return `${botName} is working. Stop it or wait for the reply.`;
  if (/Choose a thread or edit bot defaults/i.test(error)) return "Open in Settings to change this.";
  return error;
}

/** The control's state: disabled while the writer's own busy check would refuse (whole bot or that thread, per target). */
export function controlState(view: CardView, botName: string): { enabled: boolean; line?: string } {
  if (view.card.state !== "OPEN" || view.control !== "inline") return { enabled: false, ...(view.controlNote ? { line: view.controlNote } : {}) };
  if (view.busy) return { enabled: false, line: `${botName} is working. Stop it or wait for the reply.` };
  return { enabled: true };
}

export function newChangeId(): string {
  return globalThis.crypto.randomUUID();
}

type Fetch = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Sends one tap. Transport loss and 503 COULD_NOT_CHECK re-send the SAME changeId; giving up leaves CHECKING, never OPEN. */
export async function sendTap(cardId: string, tap: TapRequest & { changeId?: string }, options: { fetch: Fetch; botName: string; attempts?: number }): Promise<TapState> {
  const changeId = tap.changeId ?? newChangeId();
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let status: number; let body: Record<string, unknown>;
    try {
      const response = await options.fetch(`/api/settings-chat/cards/${encodeURIComponent(cardId)}/apply`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: tap.value, expect: tap.expect, cardGen: tap.cardGen, changeId }),
      });
      status = response.status;
      body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (status === 200 && body.ok === true) return { kind: "settled", card: body.card as SettingCardRecord };
    // no proven answer (503, any 5xx, an unreadable body): re-send the same changeId; giving up is CHECKING
    if (status >= 500 || typeof body.code !== "string") continue;
    const code = body.code as ApplyRefusal | undefined;
    const card = body.card as SettingCardRecord | undefined;
    if (code === "VALUE_CHANGED") return { kind: "open", card, code, live: body.live, line: CHANGED_ELSEWHERE_LINE };
    if (code === "SUPERSEDED") return { kind: "open", card, code, line: NEWER_CARD_LINE };
    const line = plainWriterLine(typeof body.error === "string" ? body.error : "That change was not made.", options.botName);
    return { kind: "open", card, code, line, redrawOpen: status === 403 };
  }
  return { kind: "checking", changeId, line: COULD_NOT_CHECK_LINE, request: { value: tap.value, expect: tap.expect, cardGen: tap.cardGen } };
}

/** "Open in Settings": a Settings address only (find L1 opens it). It never calls fetch or any writer. */
export function openSettingsAddressFor(view: Pick<SettingCardView, "card">, scope: "app" | "bot"): string {
  return settingsAddressFor({ id: view.card.settingId, scope }, scope === "bot" ? view.card.botId : undefined);
}

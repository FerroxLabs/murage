import { randomBytes } from "node:crypto";
import type { TelegramUpdate } from "./telegram-update.ts";
import type { TelegramTransport } from "./telegram-transport.ts";

export interface TelegramApproval {
  id: string;
  fingerprint: string;
  summary: string;
}
export interface TelegramApprovalActions {
  pending: () => TelegramApproval[];
  resolve: (approval: TelegramApproval, behavior: "allow" | "deny") => Promise<boolean>;
}
type Owner = { senderId: string; chatId: string };
type Offer = { approval: TelegramApproval; nonce: string; expires: number; messageId?: number; consumed: boolean };
/** Process-local offers intentionally die on restart/revoke. They authorize one
 * exact pending action, not a new user turn or permanent policy change. */
export class TelegramApprovals {
  private offers = new Map<string, Offer>();
  constructor(private readonly actions: TelegramApprovalActions,
    private readonly transport: Pick<TelegramTransport, "sendMessage" | "answerCallbackQuery">,
    private readonly now: () => number = Date.now) {}
  clear() { this.offers.clear(); }
  async publish(owner: Owner, active: () => boolean, signal: AbortSignal) {
    const pending = this.actions.pending().slice(0, 32);
    for (const [id, offer] of this.offers) if (!pending.some(item => item.id === id && item.fingerprint === offer.approval.fingerprint)) this.offers.delete(id);
    for (const approval of pending) {
      if (!active()) return;
      if (this.offers.has(approval.id) || this.offers.size >= 32) continue;
      // Never ask an owner to approve details hidden by truncation.
      if (!approval.summary || approval.summary.length > 3000) continue;
      const offer: Offer = { approval: { ...approval }, nonce: randomBytes(24).toString("hex"), expires: this.now() + 600000, consumed: false };
      this.offers.set(approval.id, offer); // uncertain send must not auto-repeat
      const message = await this.transport.sendMessage({ chatId: owner.chatId,
        text: `${approval.summary}\n\nAllow once or deny this exact action. Expires in 10 minutes.`,
        buttons: [{ text: "Allow once", data: `${offer.nonce}:a` }, { text: "Deny", data: `${offer.nonce}:d` }], signal });
      if (active() && this.offers.get(approval.id) === offer) offer.messageId = message.messageId;
    }
  }
  async answer(update: Extract<TelegramUpdate, { kind: "callback" }>, owner: Owner, active: () => boolean, signal: AbortSignal) {
    if (!active() || update.senderId !== owner.senderId || update.chatId !== owner.chatId) return;
    const match = /^([a-f0-9]{48}):([ad])$/.exec(update.data);
    const offer = match && [...this.offers.values()].find(item => item.nonce === match[1]);
    let text = "This approval is expired, changed, or already answered. Review it in Murage.";
    if (offer && !offer.consumed && offer.messageId === update.messageId && this.now() < offer.expires
      && this.actions.pending().some(item => item.id === offer.approval.id && item.fingerprint === offer.approval.fingerprint)) {
      // Consume before invoking the engine; exceptions never authorize replay.
      offer.consumed = true;
      try {
        const ok = active() && await this.actions.resolve(offer.approval, match![2] === "a" ? "allow" : "deny");
        if (ok) text = match![2] === "a" ? "Allowed once." : "Denied.";
      } catch { text = "Could not confirm this decision. Review the action in Murage; do not repeat it."; }
    }
    if (active()) await this.transport.answerCallbackQuery({ id: update.callbackId, text, signal });
  }
}

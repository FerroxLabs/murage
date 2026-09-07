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
type Offer = { approval: TelegramApproval; nonce: string; expires: number; messageId?: number; consumed: boolean; outcome?: string; editAttempted?: boolean };
type ApprovalTransport = Pick<TelegramTransport, "sendMessage" | "answerCallbackQuery"> & Partial<Pick<TelegramTransport, "settleApprovalMessage">>;
/** Process-local offers intentionally die on restart/revoke. They authorize one
 * exact pending action, not a new user turn or permanent policy change. */
export class TelegramApprovals {
  private offers = new Map<string, Offer>();
  private readonly actions: TelegramApprovalActions;
  private readonly transport: ApprovalTransport;
  private readonly now: () => number;
  constructor(actions: TelegramApprovalActions,
    transport: ApprovalTransport,
    now: () => number = Date.now) {
    this.actions = actions; this.transport = transport; this.now = now;
  }
  clear() { this.offers.clear(); }
  private async settle(offer: Offer, owner: Owner, signal: AbortSignal) {
    if (!offer.outcome || !offer.messageId || offer.editAttempted || !this.transport.settleApprovalMessage) return;
    offer.editAttempted = true; // cosmetic failure never replays a decision
    try {
      await this.transport.settleApprovalMessage({ chatId: owner.chatId, messageId: offer.messageId,
        text: `${offer.approval.summary}\n\n${offer.outcome}`, signal });
    } catch { /* The callback result still reports the actual decision. */ }
  }
  async publish(owner: Owner, active: () => boolean, signal: AbortSignal) {
    const pending = this.actions.pending().slice(0, 32);
    for (const [id, offer] of this.offers) {
      if (!active()) return;
      if (!pending.some(item => item.id === id && item.fingerprint === offer.approval.fingerprint) || this.now() >= offer.expires) {
        offer.consumed = true;
        offer.outcome ??= this.now() >= offer.expires ? "Expired. Review this action in Murage." : "No longer pending. Review the decision in Murage.";
        await this.settle(offer, owner, signal);
        if (this.now() > offer.expires + 600000 || pending.some(item => item.id === id && item.fingerprint !== offer.approval.fingerprint)) this.offers.delete(id);
      }
    }
    for (const approval of pending) {
      if (!active()) return;
      if (this.offers.has(approval.id)) continue;
      if (this.offers.size >= 32) {
        const oldestSettled = [...this.offers].find(([, offer]) => offer.consumed);
        if (oldestSettled) this.offers.delete(oldestSettled[0]);
        else continue;
      }
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
    let text = offer?.consumed && offer.messageId === update.messageId && offer.outcome
      ? offer.outcome : "This approval is expired, changed, or already answered. Review it in Murage.";
    if (offer && !offer.consumed && offer.messageId === update.messageId && this.now() < offer.expires
      && this.actions.pending().some(item => item.id === offer.approval.id && item.fingerprint === offer.approval.fingerprint)) {
      // Consume before invoking the engine; exceptions never authorize replay.
      offer.consumed = true;
      try {
        const ok = active() && await this.actions.resolve(offer.approval, match![2] === "a" ? "allow" : "deny");
        if (ok) text = match![2] === "a" ? "Allowed once." : "Denied.";
      } catch { text = "Could not confirm this decision. Review the action in Murage; do not repeat it."; }
      offer.outcome = text;
    }
    if (active()) {
      try { await this.transport.answerCallbackQuery({ id: update.callbackId, text, signal }); }
      finally { if (active() && offer?.consumed) await this.settle(offer, owner, signal); }
    }
  }
}

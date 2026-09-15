import { randomBytes } from "node:crypto";
import type { TelegramApproval, TelegramApprovalActions } from "../telegram-approvals.ts";

/** Provider adapters admit only authenticated, human, private-message interactions. */
export interface PermissionAction {
  provider: "discord" | "slack";
  applicationId?: string;
  teamId?: string;
  userId: string;
  channelId: string;
  messageId: string;
  actionId: string;
  ack: () => Promise<void>;
}
export interface PermissionMessages {
  send(input: { dmId: string; text: string; approveId: string; denyId: string; signal: AbortSignal }): Promise<{ messageId: string }>;
  settle(input: { dmId: string; messageId: string; text: string; signal: AbortSignal }): Promise<void>;
}
interface Options {
  provider: PermissionAction["provider"];
  applicationId: string;
  teamId?: string;
  ownerUserId: string;
  dmId: string;
  actions: Pick<TelegramApprovalActions, "pending" | "resolve">;
  messages: PermissionMessages;
  active: () => boolean;
  maxText: number;
  now?: () => number;
}
interface Offer {
  approval: TelegramApproval;
  nonce: string;
  expires: number;
  messageId?: string;
  consumed: boolean;
  outcome?: string;
  editAttempted?: boolean;
}
const HINT = "\n\nApprove once or deny this exact action. Expires in 10 minutes.";
const TTL = 600_000;

/** Process-local offers: a restart/revoke cannot reuse a previously delivered button. */
export class PermissionApprovals {
  private readonly offers = new Map<string, Offer>();
  private readonly abort = new AbortController();
  private publishing = false;
  private readonly options: Options;
  constructor(options: Options) { this.options = options; }
  private now() { return this.options.now?.() ?? Date.now(); }
  private active() { return !this.abort.signal.aborted && this.options.active(); }
  clear() { this.abort.abort(); this.offers.clear(); }
  private pending(offer: Offer) {
    return this.options.actions.pending().some(item => !item.questions?.length && item.id === offer.approval.id && item.fingerprint === offer.approval.fingerprint);
  }
  private async settle(offer: Offer) {
    if (!this.active() || !offer.messageId || !offer.outcome || offer.editAttempted) return;
    offer.editAttempted = true;
    try {
      await this.options.messages.settle({ dmId: this.options.dmId, messageId: offer.messageId,
        text: `${offer.approval.summary}\n\n${offer.outcome}`, signal: this.abort.signal });
    } catch { /* A cosmetic edit failure never retries the decision. */ }
  }
  async publish() {
    if (!this.active() || this.publishing) return;
    this.publishing = true;
    try {
      const pending = this.options.actions.pending().filter(item => !item.questions?.length).slice(0, 32);
      for (const [id, offer] of this.offers) {
        if (!this.active()) return;
        const same = pending.some(item => item.id === id && item.fingerprint === offer.approval.fingerprint);
        if (!same || this.now() >= offer.expires) {
          offer.consumed = true;
          offer.outcome ??= this.now() >= offer.expires ? "Expired. Review this action in Murage." : "No longer pending. Review the decision in Murage.";
          await this.settle(offer);
          if (this.now() > offer.expires + TTL || pending.some(item => item.id === id && item.fingerprint !== offer.approval.fingerprint)) this.offers.delete(id);
        }
      }
      for (const approval of pending) {
        if (!this.active()) return;
        if (this.offers.has(approval.id) || !approval.summary || approval.summary.length + HINT.length > this.options.maxText) continue;
        if (this.offers.size >= 32) {
          const settled = [...this.offers].find(([, offer]) => offer.consumed && !pending.some(item => item.id === offer.approval.id));
          if (!settled) continue;
          this.offers.delete(settled[0]);
        }
        const offer: Offer = { approval: { ...approval }, nonce: randomBytes(24).toString("hex"), expires: this.now() + TTL, consumed: false };
        this.offers.set(approval.id, offer); // Never repeat a send whose outcome is uncertain.
        const message = await this.options.messages.send({ dmId: this.options.dmId, text: approval.summary + HINT,
          approveId: `murage:${offer.nonce}:a`, denyId: `murage:${offer.nonce}:d`, signal: this.abort.signal });
        if (this.active() && this.offers.get(approval.id) === offer) offer.messageId = message.messageId;
      }
    } finally { this.publishing = false; }
  }
  async receive(event: PermissionAction): Promise<boolean> {
    const o = this.options;
    if (!this.active() || event.provider !== o.provider || event.applicationId !== o.applicationId
      || event.teamId !== o.teamId || event.userId !== o.ownerUserId || event.channelId !== o.dmId) return false;
    const match = /^murage:([a-f0-9]{48}):([ad])$/.exec(event.actionId);
    if (!match) return false;
    const offer = [...this.offers.values()].find(item => item.nonce === match[1]);
    if (!offer || !offer.messageId || event.messageId !== offer.messageId || offer.consumed) return false;
    if (this.now() >= offer.expires || !this.pending(offer)) {
      offer.consumed = true; offer.outcome = "No longer pending. Review this action in Murage.";
      await this.settle(offer); return false;
    }
    // The adapter has acknowledged the interaction. Consume before any asynchronous resolution.
    offer.consumed = true;
    let resolved = false;
    try {
      resolved = this.active() && await o.actions.resolve(offer.approval, match[2] === "a" ? "allow" : "deny");
      offer.outcome = resolved ? (match[2] === "a" ? "Approved once." : "Denied.") : "No longer pending. Review this action in Murage.";
    } catch { offer.outcome = "Decision unconfirmed. Check Murage; do not repeat."; }
    await this.settle(offer);
    return resolved;
  }
}

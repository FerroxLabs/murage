import type { FluxEmailClient } from "../email/flux-email-client.ts";

export type MailReadPort = Pick<FluxEmailClient, "listMessages" | "getMessage" | "getThread">;

// M3 supplies the account's local reader. W supplies Store.beginMailboxSeal before C0's EmailTools can use it.
export interface MailboxReadBinding {
  inboxId: string;
  port: MailReadPort;
  seal(threadId: string): "pending" | "complete";
}

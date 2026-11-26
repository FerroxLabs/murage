// Settings v10 C5 (producer: roster). One review before archiving a bot that has saved app choices.
// `openArchiveReview(bot)` shows ConfirmClearsAppChoices, then sends the archive PATCH with the reviewed
// `accessRevision`; the server's archive guard (server/settings/archive-guard.ts) answers 409 if it moved.
import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { ConfirmClearsAppChoices } from "@/components/settings/ConfirmClearsAppChoices";
import { api } from "@/state/store";
import type { ArchiveReviewBot, ArchiveReviewOutcome } from "../../shared/settings-v10/archive-review";

type Send = (path: string, init: { method: "PATCH"; body: string }) => Promise<unknown>;

/** Archive one reviewed bot. A 409 is "conflict" (nothing archived, nothing reset); anything else that fails is thrown. */
export async function archiveReviewed(bot: ArchiveReviewBot, send: Send = api as Send): Promise<{ outcome: "archived" | "conflict"; response?: unknown }> {
  try {
    const response = await send(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify({ hidden: true, accessRevision: bot.accessRevision }) });
    return { outcome: "archived", response };
  } catch (cause) {
    if ((cause as { status?: number }).status === 409) return { outcome: "conflict" };
    throw cause;
  }
}

/** Archive each ticked bot on its own revision. A changed bot is left alone and named; the rest archive. */
export async function archiveReviewedList(
  bots: ArchiveReviewBot[],
  send: Send = api as Send,
): Promise<{ archived: ArchiveReviewBot[]; changed: ArchiveReviewBot[]; failed: Array<{ bot: ArchiveReviewBot; message: string }> }> {
  const out = { archived: [] as ArchiveReviewBot[], changed: [] as ArchiveReviewBot[], failed: [] as Array<{ bot: ArchiveReviewBot; message: string }> };
  for (const bot of bots) {
    try {
      (await archiveReviewed(bot, send)).outcome === "archived" ? out.archived.push(bot) : out.changed.push(bot);
    } catch (cause) {
      out.failed.push({ bot, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }
  return out;
}

/** Show the review for one bot. Resolves "cancelled" if dismissed, otherwise the archive's outcome. */
export function openArchiveReview(bot: ArchiveReviewBot, options: { onArchived?: (response: unknown) => void } = {}): Promise<ArchiveReviewOutcome> {
  return new Promise((resolve, reject) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const close = () => {
      root.unmount();
      host.remove();
    };
    root.render(
      createElement(ConfirmClearsAppChoices, {
        bots: [bot],
        action: "archive",
        onCancel: () => {
          close();
          resolve("cancelled");
        },
        onConfirm: () => {
          close();
          archiveReviewed(bot).then((result) => {
            if (result.outcome === "archived") options.onArchived?.(result.response);
            resolve(result.outcome);
          }, reject);
        },
      }),
    );
  });
}

/** Read a bot's current access policy for the review: its revision and the apps its saved choices name. */
export async function readArchiveReviewBot(bot: { id: string; name: string }, read: (path: string) => Promise<any> = api as (path: string) => Promise<any>): Promise<ArchiveReviewBot> {
  const view = (await read(`/api/bots/${encodeURIComponent(bot.id)}/access`)) as { policy?: { revision?: number; mode?: string; allowWrites?: boolean; grants?: Array<{ toolkit: string }> } };
  const revision = Number(view.policy?.revision ?? 0);
  const savedChoices = [...new Set((view.policy?.grants ?? []).map((grant) => grant.toolkit))].sort();
  // Nothing saved is exactly the default policy (revision 0, unrestricted, writes on, no grants). Anything else is saved, even with no apps chosen.
  const hasSavedPolicy = savedChoices.length > 0 || revision !== 0 || view.policy?.mode !== "unrestricted" || view.policy?.allowWrites !== true;
  return { id: bot.id, name: bot.name, accessRevision: revision, savedChoices, hasSavedPolicy };
}

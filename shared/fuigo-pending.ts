// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLOUD-FUIGO-FIRST (docs/designs/cloud-fuigofirst/DESIGN.md): on a Cloud home a bot Murage picked the engine for is born on Fuigo
// even while the Flux key is on its way, with no model yet: FUIGO PENDING. The server (birth, the send guard, the key-lands fill)
// and the client (the chat gate, the model chip) read the same predicate and the same approved words.

/** CLOUD-NOKEY-FALLBACK: the approved words while a Cloud home's Flux credit is still on its way. Other engines are one line that
 * points at Settings, Engines; nothing here offers another engine's sign-in. */
export const FUIGO_READY_COPY = {
  title: "Getting Fuigo ready",
  line: "Your bots run on Fuigo with your Flux credit. This takes a minute or two. You can keep looking around.",
  slow: "Fuigo is taking longer than usual. We're on it. Need help? Email support@murage.ai.",
  others: "Prefer your own Claude, ChatGPT or Grok sign-in? Add it in Settings.",
} as const;

/** What a send to a pending bot is answered with: the ready card's own title and line. */
export const FUIGO_PENDING_SEND_LINE = `${FUIGO_READY_COPY.title}. ${FUIGO_READY_COPY.line}`;

/** A Cloud home bot on Fuigo with no model yet. Always false off a home and for any other engine. */
export function fuigoPending(cloudHome: boolean, driverKind: string | undefined, model: string | undefined): boolean {
  return cloudHome && driverKind === "fuigoAgent" && !(model ?? "").trim();
}

/** The client's read of a send the server refused as pending (409 fuigo_pending): the composer shows the approved line and keeps the words. */
export function isFuigoPendingRefusal(error: unknown): boolean {
  const refused = error as { status?: unknown; body?: { code?: unknown } } | null | undefined;
  return refused?.status === 409 && refused.body?.code === "fuigo_pending";
}

/** How the server settles an accepted send whose turn was refused before anything ran (review H-A, MC63 ruling option a). A pending
 * refusal is "cancelled": no refused chip ("Not sent", Send again), no held row after a restart, so the client's ready line and the
 * words in the box stand. Every other refusal keeps its words as a refused chip. */
export function startRefusalSettle(error: unknown): "cancelled" | "refused" {
  return (error as { code?: unknown } | null | undefined)?.code === "fuigo_pending" ? "cancelled" : "refused";
}

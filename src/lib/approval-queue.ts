// Every pending card in the conversation, not only the first (AMEND-13 Rule 83).
//
// The composer panel, the phone and both calls show the owner a QUEUE of open
// requests. These helpers keep that queue honest: selection follows a request's
// own id (never an array index), new cards append without moving it, and a card
// that settles elsewhere hands the selection to the next one still waiting.
// Voice answers only the card it presented; these read what the owner said.

/** Which request is selected, and the order the owner last saw. */
export interface QueueSelection {
  id?: string;
  order: string[];
}

/**
 * The selection after the list changed (Rule 83a, 83b). A selected request that
 * is still pending stays selected, wherever new cards land. One that settled (here,
 * on another device, or by a branch or thread change) hands over to the next
 * pending request after it in the order the owner saw, else to the first card
 * that arrived since, else to the last one left. Nothing selected: the oldest.
 * Selection never answers anything.
 */
export function nextSelection(prev: QueueSelection, list: readonly { requestId: string }[]): QueueSelection {
  const order = list.map((item) => item.requestId);
  if (!order.length) return { order };
  if (prev.id && order.includes(prev.id)) return { id: prev.id, order };
  if (!prev.id) return { id: order[0], order };
  const at = prev.order.indexOf(prev.id);
  const seenUpTo = new Set(at >= 0 ? prev.order.slice(0, at + 1) : []);
  const after = order.filter((id) => !seenUpTo.has(id));
  return { id: after[0] ?? order[order.length - 1], order };
}

/** The selection moved by the owner to another listed request (Rule 83a). An id
 * not in the list changes nothing. */
export function selectRequest(prev: QueueSelection, list: readonly { requestId: string }[], id: string): QueueSelection {
  const order = list.map((item) => item.requestId);
  return order.includes(id) ? { id, order } : nextSelection(prev, list);
}

/** The request after the selected one, wrapping to the oldest (voice "next"). */
export function followingRequest(list: readonly { requestId: string }[], id: string | undefined): string | undefined {
  if (!list.length) return undefined;
  const at = id ? list.findIndex((item) => item.requestId === id) : -1;
  return list[(at + 1) % list.length]!.requestId;
}

/** "N requests waiting", as the panel heading and the voice lead say it. */
export function requestsWaiting(count: number): string {
  return count === 1 ? "1 request waiting" : `${count} requests waiting`;
}

/** Where a listed card's answer is (Rule 83b): sending holds only that card,
 * a failed answer stays listed with a retry. */
export type QueueStatus = "waiting" | "sending" | "failed";

export function queueStatusWords(status: QueueStatus): string {
  if (status === "sending") return "Sending your answer";
  if (status === "failed") return "Not sent. Try again";
  return "Waiting for you";
}

/** What the owner said about the queue itself on a call (Rule 83c). None of
 * these answers a request: "next" moves on, "read" lists every request, a
 * number picks one. */
export type QueueCommand = { kind: "next" } | { kind: "read" } | { kind: "select"; index: number };

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const LEAD = /^(?:(?:um+|uh+|er+|so|well|oh|ok(?:ay)?|and)[,.\s]+)*/i;
const NEXT = /^(?:(?:go to |move on to |on to )?(?:the )?next(?: one| request)?|what'?s next|move on)[.!?]*$/i;
const READ = /^(?:(?:please |can you |could you )?(?:read|list|say|tell me)(?: me)? (?:them|them all|all of them|all|every(?: one| request)|each(?: one)?|the (?:list|requests)|what'?s waiting)|what are (?:they|the requests)|which requests|what'?s waiting)[.!?]*$/i;
const SELECT = new RegExp(
  `^(?:(?:go to|pick|choose|answer|open|read) )?(?:the )?(?:number |request |request number )?(${Object.keys(ORDINALS).join("|")}|\\d{1,2})(?: one| request)?[.!?]*$`,
  "i",
);

export function queueCommand(said: string): QueueCommand | null {
  const text = said.trim().replace(/[‘’]/g, "'").replace(LEAD, "").trim();
  if (!text) return null;
  if (NEXT.test(text)) return { kind: "next" };
  if (READ.test(text)) return { kind: "read" };
  const pick = SELECT.exec(text);
  if (pick) {
    const word = pick[1]!.toLowerCase();
    const index = ORDINALS[word] ?? Number(word);
    if (Number.isInteger(index) && index >= 1) return { kind: "select", index };
  }
  return null;
}

/** An answer that reaches past the one presented request ("yes to all", "both",
 * "allow everything"): with more than one waiting it answers nothing and the
 * call asks which (Rule 83c, no implicit approve-all). */
export function reachesPastOneRequest(said: string): boolean {
  return /\b(all|both|every|everything|everyone|each|them)\b/i.test(said);
}

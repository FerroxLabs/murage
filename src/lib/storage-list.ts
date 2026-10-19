// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings > Storage's list of attachment files (1.0.3, list only), as plain
// lines and a pager. Pure so it is tested without a renderer. The answer
// GET /api/storage/attachments gives (server/storage-attachments.ts).
//
// The list never asks for a file's bytes: each row's icon comes from its kind,
// and the only route this pager calls is the list route (R1.9).

export type FileKind = "image" | "document" | "audio" | "video" | "other";
export type UsedIn = { state: "used"; labels: string[]; more: boolean } | { state: "unused" } | { state: "unknown" };
export interface StorageListItem { name: string; bytes: number; modifiedAt: number; kind: FileKind; usedIn: UsedIn }
export interface StorageListTotals {
  count: number;
  bytes: number;
  other: { count: number; bytes: number; unreadable: number; firstError?: string };
  vanished: number;
  truncated: boolean;
}
export interface StorageListPage {
  state: "ok";
  snapshot: string;
  order: StorageOrder;
  items: StorageListItem[];
  nextCursor: string | null;
  totals: StorageListTotals;
  coverageComplete: boolean;
}
export type StorageListAnswer = StorageListPage | { state: "unreadable"; message: string };
export type StorageOrder = "size" | "newest";

export const LIST_ROUTE = "/api/storage/attachments";
export const PAGE_SIZE = 50;

export const KIND_LABEL: Record<FileKind, string> = { image: "Image", document: "Document", audio: "Audio", video: "Video", other: "Other file" };
export const UNREADABLE_LINE = "Murage could not read its attachments folder.";
export const STALE_LINE = "The list changed; reload it.";
export const INDEXING_LINE = "Murage is still indexing older conversations; where some files are used will show when that finishes.";
export const TRUNCATED_LINE = "Murage looked at the first 100,000 entries in its attachments folder and there are more. Sizes and the list cover those 100,000.";
export const LOAD_FAILED_LINE = "The list could not be loaded. Try again in a moment.";

/** Entries renamed or removed while the walk ran: a reload shows the new state (R1.8). */
export function vanishedLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "file" : "files"} changed while Murage was looking; reload to see them.`;
}

/** Entries the walk could not examine. Never a reload instruction: a permission or disk failure stays (R1.8). */
export function unreadableEntriesLine(count: number, code?: string): string | null {
  if (count <= 0) return null;
  const code_ = code && /^E[A-Z0-9]+$/.test(code) ? ` (${code})` : "";
  return `${count} ${count === 1 ? "entry" : "entries"} in the attachments folder could not be examined${code_}; ${count === 1 ? "it is" : "they are"} not counted.`;
}

/** The notices over the list, in order. */
export function listNotices(page: StorageListPage): string[] {
  return [
    page.totals.truncated ? TRUNCATED_LINE : null,
    vanishedLine(page.totals.vanished),
    unreadableEntriesLine(page.totals.other.unreadable, page.totals.other.firstError),
    page.coverageComplete ? null : INDEXING_LINE,
  ].filter((line): line is string => line !== null);
}

/** "Used in" for one row (R1.6, R1.7). */
export function usedInLine(usedIn: UsedIn): string {
  if (usedIn.state === "unused") return "Not in any sent message (it may still be in a draft)";
  if (usedIn.state === "unknown") return "Not checked yet";
  return `${usedIn.labels.join(", ")}${usedIn.more ? " and possibly more" : ""}`;
}

export function listUrl(order: StorageOrder, snapshot?: string, cursor?: string): string {
  const query = new URLSearchParams({ order, limit: String(PAGE_SIZE) });
  if (snapshot) query.set("snapshot", snapshot);
  if (cursor) query.set("cursor", cursor);
  return `${LIST_ROUTE}?${query}`;
}

export type StorageListState =
  | { phase: "loading" }
  | { phase: "unreadable" }
  | { phase: "failed"; stale: boolean }
  | { phase: "ready"; order: StorageOrder; snapshot: string; items: StorageListItem[]; nextCursor: string | null; notices: string[]; totals: StorageListTotals; loadingMore: boolean };

/** Loads the first page for an order, or the next page of the current snapshot. `get` is the app's api(). */
export async function loadFirst(get: (url: string) => Promise<StorageListAnswer>, order: StorageOrder): Promise<StorageListState> {
  try {
    const answer = await get(listUrl(order));
    if (answer.state === "unreadable") return { phase: "unreadable" };
    return { phase: "ready", order, snapshot: answer.snapshot, items: answer.items, nextCursor: answer.nextCursor, notices: listNotices(answer), totals: answer.totals, loadingMore: false };
  } catch (error) {
    return { phase: "failed", stale: (error as { status?: number })?.status === 409 };
  }
}

export async function loadMore(get: (url: string) => Promise<StorageListAnswer>, state: Extract<StorageListState, { phase: "ready" }>): Promise<StorageListState> {
  if (!state.nextCursor) return state;
  try {
    const answer = await get(listUrl(state.order, state.snapshot, state.nextCursor));
    if (answer.state === "unreadable") return { phase: "unreadable" };
    return { ...state, items: [...state.items, ...answer.items], nextCursor: answer.nextCursor, loadingMore: false };
  } catch (error) {
    return { phase: "failed", stale: (error as { status?: number })?.status === 409 };
  }
}

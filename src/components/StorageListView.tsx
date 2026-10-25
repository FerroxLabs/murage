// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings > Storage's attachment list as markup, from its state alone, so it
// is tested without a browser (StorageList.tsx loads the state). Each row shows
// a kind icon, never a preview: rendering the list asks for no file's bytes (R1.9).
import { FileAudio, FileImage, FileQuestion, FileText, FileVideo } from "lucide-react";
import { readableBytes } from "@/lib/storage-summary";
import { INDEXING_LINE, isBotPicture, KIND_LABEL, LOAD_FAILED_LINE, PICTURE_IN_USE_LINE, REMOVE_CONFIRM_LINE, STALE_LINE, UNREADABLE_LINE, usedInLine, type FileKind, type StorageListState, type StorageOrder } from "@/lib/storage-list";

const ICONS: Record<FileKind, typeof FileImage> = { image: FileImage, document: FileText, audio: FileAudio, video: FileVideo, other: FileQuestion };
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Remove on each row (1.0.4 SL-H), when this computer offers it. */
export interface StorageRemoveControls {
  /** The row whose confirm is open. */
  confirming: string | null;
  /** The row being removed now. */
  removing: string | null;
  /** How the last Remove went. */
  notice: string | null;
  onAsk: (name: string) => void;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}

/** The list as markup, from its state alone (tested without a browser). */
export function StorageListView({ state, order, onOrder, onMore, onReload, remove }: {
  state: StorageListState;
  order: StorageOrder;
  onOrder: (order: StorageOrder) => void;
  onMore: () => void;
  onReload: () => void;
  remove?: StorageRemoveControls;
}) {
  const reloadButton = (
    <button type="button" onClick={onReload} className="rounded-md border border-hairline/60 px-2.5 py-1 text-[12.5px] text-ink">Reload the list</button>
  );
  return (
    <section aria-label="Attachment files" className="flex flex-col gap-2 text-[13px]">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[13px] font-medium text-ink">Attachment files</h4>
        <div role="group" aria-label="Order" className="flex gap-1">
          {(["size", "newest"] as const).map(option => (
            <button key={option} type="button" aria-pressed={order === option} onClick={() => onOrder(option)}
              className={`rounded-md px-2 py-0.5 text-[12px] ${order === option ? "bg-control text-ink" : "text-ink-secondary"}`}>
              {option === "size" ? "Largest first" : "Newest first"}
            </button>
          ))}
        </div>
      </div>
      {state.phase === "loading" && <p className="text-ink-secondary">Looking through the attachments folder...</p>}
      {state.phase === "unreadable" && <div className="flex flex-col gap-2"><p role="alert" className="text-warning">{UNREADABLE_LINE}</p><div>{reloadButton}</div></div>}
      {state.phase === "failed" && <div className="flex flex-col gap-2"><p role="alert" className="text-warning">{state.stale ? STALE_LINE : LOAD_FAILED_LINE}</p><div>{reloadButton}</div></div>}
      {remove?.notice && <p role="status" className="text-ink-secondary">{remove.notice}</p>}
      {state.phase === "ready" && (
        <>
          {state.notices.map(line => <p key={line} className="text-ink-secondary">{line}</p>)}
          {state.items.length === 0
            ? <p className="text-ink-secondary">{state.notices.some(line => line !== INDEXING_LINE) ? "No attachment files could be listed." : "No attachment files yet."}</p>
            : (
              <>
                <p className="text-ink-secondary">{state.totals.count.toLocaleString()} {state.totals.count === 1 ? "file" : "files"}, {readableBytes(state.totals.bytes)}</p>
                <ul className="flex flex-col divide-y divide-hairline/40">
                  {state.items.map(item => {
                    const Icon = ICONS[item.kind] ?? FileQuestion;
                    return (
                      <li key={item.name} data-storage-row className="grid grid-cols-[auto_1fr_auto] items-start gap-x-3 py-1.5">
                        <Icon aria-label={KIND_LABEL[item.kind] ?? KIND_LABEL.other} className="mt-0.5 h-4 w-4 text-ink-secondary" />
                        <div className="min-w-0">
                          <div className="truncate text-ink" title={item.name}>{KIND_LABEL[item.kind] ?? KIND_LABEL.other} <span className="text-ink-secondary">{item.name}</span></div>
                          <div className="text-[12px] text-ink-secondary">Used in: {usedInLine(item.usedIn)}</div>
                        </div>
                        <div className="text-right tabular-nums text-ink-secondary">
                          <div className="text-ink">{readableBytes(item.bytes)}</div>
                          <div className="text-[12px]">{day(item.modifiedAt)}</div>
                          {remove && remove.confirming !== item.name && (
                            <button type="button" data-storage-remove disabled={isBotPicture(item.usedIn) || remove.removing !== null}
                              title={isBotPicture(item.usedIn) ? PICTURE_IN_USE_LINE : undefined} onClick={() => remove.onAsk(item.name)}
                              className="mt-0.5 text-[12px] text-ink-secondary underline disabled:no-underline disabled:opacity-50">
                              Remove
                            </button>
                          )}
                        </div>
                        {remove && remove.confirming === item.name && (
                          <div role="group" aria-label="Remove this file" className="col-span-3 mt-1 flex flex-wrap items-center gap-2 text-[12.5px]">
                            <span className="text-ink">{REMOVE_CONFIRM_LINE}</span>
                            <button type="button" data-storage-remove-confirm disabled={remove.removing !== null} onClick={() => remove.onConfirm(item.name)}
                              className="rounded-md border border-hairline/60 px-2 py-0.5 text-ink">{remove.removing === item.name ? "Removing..." : "Remove"}</button>
                            <button type="button" disabled={remove.removing !== null} onClick={remove.onCancel} className="rounded-md px-2 py-0.5 text-ink-secondary">Keep it</button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {state.nextCursor && (
                  <div>
                    <button type="button" disabled={state.loadingMore} onClick={onMore} className="rounded-md border border-hairline/60 px-2.5 py-1 text-[12.5px] text-ink">
                      {state.loadingMore ? "Loading..." : "Show more"}
                    </button>
                  </div>
                )}
              </>
            )}
        </>
      )}
    </section>
  );
}

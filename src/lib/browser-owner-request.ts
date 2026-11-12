export type BrowserSelectionView = { selectionRevision?: number; sessionKey?: string };
/** Capture with the generation before queuing input, never from a later poll. */
export function browserOwnerFields(status: BrowserSelectionView | null | undefined) {
  return Number.isSafeInteger(status?.selectionRevision) && typeof status?.sessionKey === 'string'
    ? { expectedRevision: status!.selectionRevision, expectedKey: status!.sessionKey }
    : {};
}
export function browserInputFailure(error: { code?: string; message?: string }) {
  return ['client_outdated', 'revision_changed', 'browser_closing', 'browser_close_failed'].includes(error.code ?? '') && error.message
    ? error.message : 'Input stopped because browser control changed.';
}

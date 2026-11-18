export const LEARNING_NOTICE_KEY = "murage.learningFluxNoticeShown";
export const LEARNING_NOTICE = "Murage learns from your chats using Flux. You can change this in Settings.";
const listeners = new Set<() => void>();
let state: string | null = null;
let unpersisted = false;

function read(): string | null {
  try {
    const stored = globalThis.localStorage?.getItem(LEARNING_NOTICE_KEY) ?? null;
    if (!unpersisted) state = stored;
  } catch { /* Keep this renderer's state when storage is blocked. */ }
  return state;
}
function write(value: string): void {
  state = value;
  unpersisted = true;
  try {
    const storage = globalThis.localStorage;
    if (storage) { storage.setItem(LEARNING_NOTICE_KEY, value); unpersisted = false; }
  } catch { /* A replacement surface still sees the in-memory state. */ }
}
export function requestLearningNotice(dismissShown: boolean): void {
  const shown = read() === "shown";
  if (shown && !dismissShown) return;
  if (!shown) write("pending");
  for (const listener of listeners) listener();
}
export const learningNoticePending = (): boolean => read() === "pending";
export function subscribeLearningNotice(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Called only after a mounted surface has displayed the notice. */
export function markLearningNoticeShown(): void { write("shown"); }

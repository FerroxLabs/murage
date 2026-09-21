// An image intake that is still running belongs to the draft the person is
// looking at, not to the next one.
//
// Attaching an image is not instant: the file is uploaded and only then does
// a chip appear. Nothing used to stop a send during that gap. Press Enter
// while the upload is in flight and `send()` composed the message out of
// whatever attachments existed at that instant — which did not include the
// image — then cleared the draft. The upload finished a moment later and
// appended the image to the now-empty draft, so the picture the person
// believed they had just sent turned up on their NEXT message instead.
//
// The counter below is what a composer consults before it sends. It is keyed
// by thread so an upload running in one conversation never blocks another.
//
// The window that matters is the WHOLE intake, not just the network call:
// `intakeFiles` resolves its upload, keeps going through the remaining files,
// and only afterwards does the caller append the chips. Counting just the
// fetch would reopen the same gap a few lines further down. So the count is
// held until the tracked callback has returned, and every call site wraps the
// append inside it.

const pending = new Map<string, number>();
const listeners = new Set<() => void>();

/** One unbound bucket: a composer without a thread still has one intake. */
function bucket(threadId: string | undefined): string {
  return threadId ?? "";
}

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/** Whether an image intake for this thread has not finished attaching yet. */
export function composerUploadsPending(threadId?: string): boolean {
  return (pending.get(bucket(threadId)) ?? 0) > 0;
}

/** React's external-store subscription; every change to any thread's count
 * notifies, and the snapshot each composer reads is its own thread's. */
export function subscribeComposerUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Runs one intake with this thread marked busy for its whole duration,
 * including the appending the callback does after the upload resolves.
 * The count is released in a `finally`, so a refused or failed upload can
 * never leave a composer permanently unable to send. */
export async function trackComposerUpload<T>(
  threadId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const key = bucket(threadId);
  pending.set(key, (pending.get(key) ?? 0) + 1);
  announce();
  try {
    return await run();
  } finally {
    const left = (pending.get(key) ?? 1) - 1;
    if (left > 0) pending.set(key, left);
    else pending.delete(key);
    announce();
  }
}

/** Test-only reset; the counter is module state shared by every composer. */
export function resetComposerUploads(): void {
  pending.clear();
  listeners.clear();
}

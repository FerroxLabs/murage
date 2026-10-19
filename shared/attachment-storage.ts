// SPDX-License-Identifier: AGPL-3.0-or-later
// The words a person reads when there is no room to keep an attachment or a
// Files copy. Shared so the server's refusal and the composer's one-line
// notice say the same thing, and the composer can offer storage settings.

export const DISK_FULL_MESSAGE = "Your computer is almost out of disk space, so Murage could not save this. Free up some space, then try again.";
export const DISK_UNKNOWN_MESSAGE = "Murage could not check the free space on this disk, so it did not save this. Try again in a moment.";

/** Whether a refusal is about the disk itself, which storage settings explain. */
export function isDiskSpaceMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && (message.includes(DISK_FULL_MESSAGE) || message.includes(DISK_UNKNOWN_MESSAGE));
}

/** One line for a batch of refused files. Files refused for the same reason
 * share one sentence instead of repeating it once per file. */
export function batchRefusalLine(failures: ReadonlyArray<{ name: string; message: string }>, noun: { one: string; many: string } = { one: "image", many: "images" }): string | null {
  if (!failures.length) return null;
  const byMessage = new Map<string, string[]>();
  for (const failure of failures) byMessage.set(failure.message, [...(byMessage.get(failure.message) ?? []), failure.name]);
  return [...byMessage].map(([message, names]) => {
    const who = names.length === 1 ? `${names[0] || `The ${noun.one}`} was` : `${names.length} ${noun.many} were`;
    return `${who} not attached. ${message}`;
  }).join(" ");
}

/** The `code` a disk refusal carries in its JSON body, next to the words. */
export type DiskSpaceCode = "disk-full" | "disk-unknown";
export function isDiskSpaceCode(value: unknown): value is DiskSpaceCode {
  return value === "disk-full" || value === "disk-unknown";
}

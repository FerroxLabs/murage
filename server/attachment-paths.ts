// S5 sites 14, 16 and 17: structured attachment fields only; text history is never rewritten.
import { join } from "node:path";
import { attachmentsFolderForWriter, attachmentsHomeOf } from "./attachment-read.ts";
import { rebaseStoredPath, type Constructors, type RebaseContext } from "./stored-paths.ts";

/** The stored leaf is one segment, reconstructed under attachmentsHomeOf at each recorded root. */
export function attachmentConstructors(name: string): Constructors {
  return root => name && name !== "." && name !== ".." && !/[\\/\0]/.test(name)
    ? [join(attachmentsFolderForWriter(attachmentsHomeOf(root)), name)] : [];
}

/** All fields of a refused record stay unchanged, including otherwise eligible sibling attachments. */
export function rebaseAttachmentRecord<T extends { attachments?: unknown }>(record: T, context: RebaseContext = {}): T {
  if (!Array.isArray(record.attachments)) return record;
  let changed = false;
  const attachments: unknown[] = [];
  for (const item of record.attachments) {
    if (!item || typeof item !== "object" || typeof item.path !== "string") { attachments.push(item); continue; }
    const name = item.path.split(/[\\/]/).at(-1) ?? "";
    const outcome = rebaseStoredPath(item.path, attachmentConstructors(name), context);
    if ("refused" in outcome) return record;
    if ("path" in outcome) { attachments.push({ ...item, path: outcome.path }); changed = true; }
    else attachments.push(item);
  }
  return changed ? { ...record, attachments } : record;
}

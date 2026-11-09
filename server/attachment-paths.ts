// S5 sites 14, 16 and 17: structured attachment fields only; text history is never rewritten.
import { rebasedAttachmentPath } from "./attachment-read.ts";
import { rebaseStoredPath, type Constructors, type RebaseContext } from "./stored-paths.ts";

/** The stored leaf is one segment, reconstructed under the attachments folder of each recorded root (attachment-read.ts checks the leaf). */
export function attachmentConstructors(name: string): Constructors {
  return root => { const path = rebasedAttachmentPath(root, name); return path === null ? [] : [path]; };
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

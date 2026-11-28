// SV0-core: the stale-write guard for the bot PATCH and PUT /api/config (C11/SV0).
// Owner: lane core. A caller that shows the owner a value sends `expect: { <field>: <value shown> }`; if the live record no longer
// holds that value the write is a 409 SETTING_CHANGED and nothing is changed. A caller without `expect` is not guarded (older clients).
// A caller's optional `changeId` names the journal receipt of an accepted write (one row per change, upsert by id).
import { isDeepStrictEqual } from "node:util";
import { refusalBody } from "./refusal-refs.ts";
import type { Journal } from "./journal.ts";

export interface ExpectEnvelope { expect?: Record<string, unknown>; changeId?: string }
export type ExpectVerdict = { ok: true } | { ok: false; status: 400 | 409; body: Record<string, unknown> };

/** Takes `expect` and `changeId` out of the body (so the field validators never see them) and returns them. A bad shape is a 400 and nothing is read further. */
export function takeExpectEnvelope(body: Record<string, unknown>): { envelope: ExpectEnvelope } | { error: string } {
  const { expect, changeId } = body as { expect?: unknown; changeId?: unknown };
  delete body.expect;
  delete body.changeId;
  if (expect !== undefined && (!expect || typeof expect !== "object" || Array.isArray(expect))) return { error: "expect must be an object of the values you saw" };
  if (changeId !== undefined && (typeof changeId !== "string" || !changeId || changeId.length > 120)) return { error: "changeId must be a short text" };
  return { envelope: { ...(expect !== undefined ? { expect: expect as Record<string, unknown> } : {}), ...(changeId !== undefined ? { changeId } : {}) } };
}

/** Every named field must still hold the value the caller saw. `live` is the stored record (bot) or the saved config. */
export function checkExpect(live: Record<string, unknown> | undefined, envelope: ExpectEnvelope, scope: { bot?: string } = {}): ExpectVerdict {
  if (!envelope.expect) return { ok: true };
  const stale = Object.keys(envelope.expect).filter((key) => !isDeepStrictEqual(live?.[key], envelope.expect![key]));
  if (!stale.length) return { ok: true };
  return { ok: false, status: 409, body: refusalBody("SETTING_CHANGED", "This setting changed after you looked at it. Look again.", scope, { stale }) };
}

/** One journal receipt for an accepted write. A write the table refuses or a full disk never turns a committed change into an error. */
export function receiptFor(journal: Pick<Journal, "write">, envelope: ExpectEnvelope, row: { writer: string; settingId: string; bot?: string; before?: unknown; after?: unknown }): void {
  if (!envelope.changeId) return;
  try { journal.write({ changeId: envelope.changeId, actor: { kind: "owner" }, ...row } as never); } catch { /* the change is already committed */ }
}

/** A receipt names only fields this write both showed the owner (`expect`) and changed (the body), never a field the write left alone. */
export function receiptValues(record: unknown, expect: Record<string, unknown> | undefined, body: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!expect || !record) return undefined;
  const keys = Object.keys(expect).filter((key) => Object.hasOwn(body, key));
  return keys.length ? Object.fromEntries(keys.map((key) => [key, (record as Record<string, unknown>)[key]])) : undefined;
}

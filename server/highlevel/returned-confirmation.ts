import { createHash } from "node:crypto";
import type { HeldRequest } from "./held-request.ts";
import { prepareReturnedIdentitySchema, type BoundReturnedIdentitySchema } from "./returned-identities.ts";
import { HIGHLEVEL_RETURNED_CONFIRMATION_SCHEMAS } from "./operations/returned-confirmation-schemas.ts";
import { retainTagPostState, validTagSet } from "./returned-confirmation-state.ts";

/** Call after verifying approval/current authority, using tags captured from the
 * approved target's identity-validated preflight. Never use response tags or a
 * guessed empty pre-state. The wire body stays the reviewed add/remove delta. */
export function prepareTagReturnedIdentitySchema(held: HeldRequest, locationId: string, beforeTags: readonly string[]): BoundReturnedIdentitySchema {
  const bound = prepareReturnedIdentitySchema(held, locationId);
  const confirmation = HIGHLEVEL_RETURNED_CONFIRMATION_SCHEMAS[held.frozen.operation];
  if (confirmation.kind !== "tag_post_state" || !validTagSet(beforeTags) || held.frozen.bodyKind !== "json") throw new Error("HighLevel confirmation binding refused");
  const bytes = held.sendCopy().body;
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== held.frozen.bodySha256) throw new Error("HighLevel confirmation binding refused");
  const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!body || !validTagSet(body.tags) || body.tags.length === 0) throw new Error("HighLevel confirmation binding refused");
  const expected = confirmation.action === "add" ? [...new Set([...beforeTags, ...body.tags])]
    : beforeTags.filter(tag => !body.tags.includes(tag));
  retainTagPostState(held.frozen, expected);
  return bound;
}

import type { OperationId } from "../../../shared/highlevel.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";

/** Additive confirmation portion of each operation's returned-response schema.
 * Kept separate so the frozen F0.2 identity declarations remain unchanged. */
export type ReturnedConfirmationSchema = Readonly<{ kind: "identity_or_success" }>
  | Readonly<{ kind: "tag_post_state"; field: "tags"; action: "add" | "remove" }>;
export const HIGHLEVEL_RETURNED_CONFIRMATION_SCHEMAS: Readonly<Record<OperationId, ReturnedConfirmationSchema>> = Object.freeze(Object.fromEntries(
  HIGHLEVEL_OPERATION_MANIFEST.map(row => [row.id, Object.freeze(row.id === "contacts.tags.add"
    ? { kind: "tag_post_state", field: "tags", action: "add" }
    : row.id === "contacts.tags.remove" ? { kind: "tag_post_state", field: "tags", action: "remove" }
      : { kind: "identity_or_success" })]),
));

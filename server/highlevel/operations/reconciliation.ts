import data from "./manifest-data.json" with { type: "json" };
import type { OperationId } from "../../../shared/highlevel.ts";
import { NO_RECONCILIATION_READ_EXCEPTIONS } from "../recovery-contract.ts";

// Separate effect reads from prerequisite/ownership reads. Keep private immutable
// copies: callers cannot expand an operation's approval-time authorization.
const rows: readonly (typeof data[number] & { readonly approvalBlocked?: string })[] = data;
const declarations = new Map(rows.map(row => [row.id, Object.freeze([...row.reconciliation])]));
/** Refuse approval when no qualified reconciliation route exists. A declared
 * read authorizes observation, never proves an effect without field comparison. */
export function reconciliationReadsFor(operation: OperationId): readonly OperationId[] {
  const mutation = rows.find(row => row.id === operation);
  const reads = declarations.get(operation);
  // HL-F10-12:04 supersedes the historical all-writes-nonempty rule for this one named operation.
  // C2 still validates its exact immutable exception binding before an empty RPC target list is accepted.
  if (NO_RECONCILIATION_READ_EXCEPTIONS.some(id => id === operation) && mutation?.disposition === "ready"
    && mutation.risk !== "R" && !mutation.approvalBlocked && reads?.length === 0 && mutation.preflight.length === 0) return reads as readonly OperationId[];
  if (!mutation || mutation.risk === "R" || mutation.disposition !== "ready" || mutation.approvalBlocked || !reads?.length
    || reads.some(id => {
      const read = rows.find(row => row.id === id);
      return !read || read.risk !== "R" || read.disposition !== "ready" || !read.path || !mutation.preflight.includes(id);
    })) throw new Error("HighLevel reconciliation declaration refused");
  return reads as readonly OperationId[];
}

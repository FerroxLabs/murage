import type { HighLevelActions } from "./actions.ts";
import type { FrozenRequest } from "./held-request.ts";
import type { MutationSpec, ReadSpec, SpecBase } from "./operations/registry.ts";

// Compiled by tsconfig.server.json, never dispatched. Both F0 callers and
// one-argument family implementations must remain source-compatible.
export function f01Compatibility(
  mutation: MutationSpec, read: ReadSpec, value: unknown,
  dispatch: ReturnType<HighLevelActions["beginDispatch"]>,
): void {
  mutation.recordId?.(value);
  mutation.project(value);
  read.project(value);
  const frozen: FrozenRequest = dispatch.held.frozen;
  mutation.recordId?.(value, frozen);
  mutation.project(value, frozen);
  read.project(value, frozen);
  const legacyProject: SpecBase["project"] = (response: unknown) => response;
  const legacyRecordId: MutationSpec["recordId"] = () => undefined;
  // Context-aware implementations accept the legacy call shape, but mutation
  // hooks must refuse missing context at runtime rather than invent a target.
  const boundRecordId: MutationSpec["recordId"] = (_response: unknown, request?: FrozenRequest) => {
    if (!request) throw new Error("missing approved request context");
    return undefined;
  };
  void legacyProject; void legacyRecordId; void boundRecordId;
  // @ts-expect-error A partial/reconstructed target is not a FrozenRequest.
  mutation.recordId?.(value, { path: "/contacts/unapproved" });
}

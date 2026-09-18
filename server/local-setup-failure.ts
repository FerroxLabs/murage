// A turn-setup failure on THIS device, tagged with the part that failed so the
// transcript's card can say so instead of pointing at Provider settings
// (shared/provider-error.ts classifyLocalSetupFailure).
import type { LocalSetupFailure } from "../shared/provider-error.ts";
import { ProjectFolderLeaseError } from "./project-folder-leases.ts";

export class LocalSetupError extends Error {
  readonly localFailure: LocalSetupFailure;
  constructor(localFailure: LocalSetupFailure, message: string) {
    super(message);
    this.name = "LocalSetupError";
    this.localFailure = localFailure;
  }
}

/** Which local part a setup failure came from, when Murage knows it. A
 * working-folder lease refusal is recognised by its own class; anything else
 * must have been thrown as a LocalSetupError at the site that knew. */
export function localSetupFailureOf(error: unknown): LocalSetupFailure | undefined {
  if (error instanceof LocalSetupError) return error.localFailure;
  if (error instanceof ProjectFolderLeaseError) return "working-folder";
  return undefined;
}

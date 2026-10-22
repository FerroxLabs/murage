// A turn-setup failure on THIS device, tagged with the part that failed so the
// transcript's card can say so instead of pointing at Provider settings
// (shared/provider-error.ts classifyLocalSetupFailure).
import type { LocalSetupFailure } from "../shared/provider-error.ts";
import { ScopeUnavailableError, scopeLocalFailureOf } from "./drivers/scoped-cli-home.ts";
import { ProjectFolderLeaseError } from "./project-folder-leases.ts";

export class LocalSetupError extends Error {
  readonly localFailure: LocalSetupFailure;
  constructor(localFailure: LocalSetupFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
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
  if (error instanceof ScopeUnavailableError) return scopeLocalFailureOf(error);
  return undefined;
}

/** The engine a structured engine-folder failure is about, for the localized line. */
export function localSetupEngineOf(error: unknown): string | undefined {
  return error instanceof ScopeUnavailableError ? error.engine : undefined;
}

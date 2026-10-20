// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { HomeSignInError, type HomeSignInActor, type HomeSignInProvider } from "./model-signin.ts";

/** Close admission before asynchronous credential cleanup; failed deletion is retryable. */
export function createAccountSignInCleanup(options: {
  invalidateAll(): void;
  remove(provider: HomeSignInProvider, actor: HomeSignInActor): Promise<unknown>;
}) {
  let removing = false, removed = false;
  return {
    admissionOpen: () => !removing && !removed,
    async removeAccount(actor: HomeSignInActor) {
      if (removing || removed) throw new HomeSignInError("busy");
      removing = true;
      try {
        options.invalidateAll();
        for (const provider of ["chatgpt", "supergrok"] as const) await options.remove(provider, actor);
        removed = true;
      } finally { removing = false; }
    },
  };
}

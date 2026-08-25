import { describe, expect, it } from "vitest";

import type { CompanionAccountState } from "../types/ogb";
import { companionAccountActionError } from "./CompanionSection";

const account = (status: CompanionAccountState["status"], message?: string): CompanionAccountState => ({
  available: true,
  status,
  message,
});

describe("companion account action errors", () => {
  it("shows retry and sign-out failures while the account remains signed in", () => {
    expect(companionAccountActionError(account("ready"), "Sign out could not finish")).toBe(
      "Sign out could not finish",
    );
    expect(companionAccountActionError(account("error"), "Retry could not finish")).toBe(
      "Retry could not finish",
    );
  });

  it("uses account messages only as the signed-out fallback", () => {
    expect(companionAccountActionError(account("signed-out", "Enter a valid email"), null)).toBe(
      "Enter a valid email",
    );
    expect(companionAccountActionError(account("error", "Secure connection needs attention"), null)).toBeNull();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  applyProviderBankFenceMessage,
  modelProviderCommitAuthorized,
  PROVIDER_BANK_FENCE_ERROR,
  providerBankDispatchFenced,
} from "./provider-bank-fence.ts";

const release = () => applyProviderBankFenceMessage({ type: "murage:provider-bank-fence", held: false });

describe("provider bank uncertain fence (B4, U-14)", () => {
  afterEach(release);

  it("holds and releases dispatch only on the exact private desktop message", () => {
    expect(providerBankDispatchFenced()).toBe(false);
    expect(applyProviderBankFenceMessage({ type: "murage:provider-bank-fence", held: true })).toBe(true);
    expect(providerBankDispatchFenced()).toBe(true);
    expect(release()).toBe(true);
    expect(providerBankDispatchFenced()).toBe(false);
    expect(PROVIDER_BANK_FENCE_ERROR).toMatch(/reconciled/);
  });

  it("ignores other and malformed messages without changing the fence", () => {
    applyProviderBankFenceMessage({ type: "murage:provider-bank-fence", held: true });
    for (const message of [
      undefined,
      null,
      "murage:provider-bank-fence",
      { type: "murage:managed-composio", access: null },
      { type: "murage:provider-bank-fence" },
      { type: "murage:provider-bank-fence", held: "false" },
      { type: "murage:provider-bank-fence", held: false, extra: true },
    ]) {
      expect(applyProviderBankFenceMessage(message)).toBe(false);
      expect(providerBankDispatchFenced()).toBe(true);
    }
  });

  it("authorizes a readback only with the exact configured commit bearer", () => {
    const token = "d".repeat(64);
    expect(modelProviderCommitAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(modelProviderCommitAuthorized(`Bearer ${"e".repeat(64)}`, token)).toBe(false);
    expect(modelProviderCommitAuthorized(`bearer ${token}`, token)).toBe(false);
    expect(modelProviderCommitAuthorized(undefined, token)).toBe(false);
    expect(modelProviderCommitAuthorized(`Bearer ${token}`, "")).toBe(false);
    expect(modelProviderCommitAuthorized(["Bearer", token], token)).toBe(false);
  });
});

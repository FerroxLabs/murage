// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// INT1019-CLOUD-MERGE-PLAN R1.2 / R1.3: on a Cloud home, Fuigo's retry-notice refusal (1.0.18f path) is worded by Cloud's classifier, so no
// "Fuigo is busy" card with a gateway code reaches a customer for a 402, 401 or 403; a 429 is never claimed and keeps 1.0.19's cards.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLUX_NOT_READY_COPY, FLUX_SERVICE_HOLD_COPY } from "../../../shared/provider-error.ts";
import { cloudRetryNoticeRefusal } from "./core.ts";
import { fluxRefusalCode } from "../../flux-refusal.ts";

const OWNED = { owned: true, fromRouter: true };
const notice = (reason: string, extra: Record<string, unknown> = {}) => ({ type: "retrying", attempt: 1, reason, ...extra });

describe("Fuigo retry notice on a Cloud home", () => {
  beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("R1.2: a 402 with the Flux hold header (a headers record on the notice) is the service-hold line", () => {
    const refusal = cloudRetryNoticeRefusal(notice("API error (status 402 Payment Required): None: credit_exhausted", { headers: { "x-flux-hold-reason": "billing" } }), OWNED);
    expect(refusal?.message).toBe(FLUX_SERVICE_HOLD_COPY);
    expect(refusal?.message).not.toMatch(/credit/i);
  });
  it("R1.2: the hold header written into the notice's own text counts the same", () => {
    expect(cloudRetryNoticeRefusal(notice("API error (status 402 Payment Required): x-flux-hold-reason: billing"), OWNED)?.message).toBe(FLUX_SERVICE_HOLD_COPY);
  });
  it("R1.2: a 402 with no budget field is the not-ready line, and a 401 or 403 from the router is too", () => {
    expect(cloudRetryNoticeRefusal(notice("API error (status 402 Payment Required): None: credit_exhausted"), OWNED)?.message).toBe(FLUX_NOT_READY_COPY);
    expect(cloudRetryNoticeRefusal(notice("API error (status 401 Unauthorized): None"), OWNED)?.message).toBe(FLUX_NOT_READY_COPY);
    expect(cloudRetryNoticeRefusal(notice("403 Forbidden: nope"), OWNED)?.message).toBe(FLUX_NOT_READY_COPY);
  });
  it("R1.2: a numeric status field and a budget field are read too; the budget line names its reset day", () => {
    const refusal = cloudRetryNoticeRefusal(notice("credit_exhausted", { http_status: 402, provider_specific_fields: { error: "key_budget_reached", resets_at: "2030-03-05T00:00:00Z" } }), OWNED);
    expect(refusal?.message).toContain("They come back on March 5.");
  });
  it("R1.3: a 429 (free cap, hourly, hold, busy) is never claimed, so 1.0.19's gateway cards keep it", () => {
    const freeCap = "429 Too Many Requests: {'error': {'type': 'rate_limit_exceeded', 'state': 'free_cap_reached'}}";
    for (const reason of [freeCap, "API error (status 429 Too Many Requests): None: hourly_burn_limit", "429 Too Many Requests: Your credit is busy because other requests have temporarily reserved it. Retry in 2s.", "429 Too Many Requests: rate limited"]) {
      expect(cloudRetryNoticeRefusal(notice(reason), OWNED), reason).toBeNull();
    }
    expect(fluxRefusalCode(freeCap)).toBe("free_cap_reached");
  });
  it("no status on the notice means nothing for the Cloud classifier to claim", () => {
    expect(cloudRetryNoticeRefusal(notice("something went wrong"), OWNED)).toBeNull();
    expect(cloudRetryNoticeRefusal(undefined, OWNED)).toBeNull();
  });
});

describe("Fuigo retry notice off a Cloud home", () => {
  it("the Cloud classifier never runs: the answer is null for a 402 too", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    try { expect(cloudRetryNoticeRefusal(notice("API error (status 402 Payment Required): None: credit_exhausted"), OWNED)).toBeNull(); } finally { vi.unstubAllEnvs(); }
  });
});

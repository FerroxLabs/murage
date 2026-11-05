import { describe, expect, it } from "vitest";

import { FLUX_BILLING_PAGE, FLUX_DASHBOARD_BILLING_PAGE, FLUX_KEYS_PAGE, fluxSignInUrl } from "./flux-links.ts";
import { providerErrorPresentation } from "./provider-error.ts";

describe("Flux pages that need a session open through Flux sign-in", () => {
  it("encodes the page as one return_to value", () => {
    expect(FLUX_KEYS_PAGE).toBe("https://fluxrouter.ai/auth/sign-in?return_to=%2Fhome%2Fapi-keys");
    expect(FLUX_BILLING_PAGE).toBe("https://fluxrouter.ai/auth/sign-in?return_to=%2Fhome%2Fbilling");
    expect(FLUX_DASHBOARD_BILLING_PAGE).toBe("https://fluxrouter.ai/auth/sign-in?return_to=%2Fdashboard%2Fbilling");
    expect(fluxSignInUrl("/home/billing?x=1&return_to=https://evil.invalid")).not.toMatch(/&return_to=/);
  });

  it("refuses anything but a Flux path", () => {
    expect(() => fluxSignInUrl("https://evil.invalid/")).toThrow();
    expect(() => fluxSignInUrl("//evil.invalid/")).toThrow();
  });

  it("the credits card links billing through sign-in", () => {
    expect(providerErrorPresentation({ kind: "credits", provider: "flux-router", httpStatus: 402 }).billingUrl).toBe(FLUX_BILLING_PAGE);
  });
});

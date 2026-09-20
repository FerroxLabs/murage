import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyLocalResourceConflict, classifyProviderError, LOCAL_RESOURCE_BUSY_MESSAGES, providerErrorPresentation, type ProviderErrorInfo } from "./provider-error.ts";

describe("local resource contention", () => {
  it("recognizes exactly the refusal copy the server throws for held leases", () => {
    const thrown = ["../server/index.ts", "../server/independent-thread-runs.ts"].flatMap((file) =>
      [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/"(Another thread is using [^"]+)"/g)].map((match) => match[1]));
    // Setup now waits for held folders, computers and browsers; only admission's
    // resource_busy conflict still throws. The other entries stay recognized so
    // refusals saved by earlier builds keep their wait/retry card.
    for (const message of thrown) expect(LOCAL_RESOURCE_BUSY_MESSAGES.has(message)).toBe(true);
    expect(thrown).toEqual(["Another thread is using this browser, computer or working folder."]);
    expect(classifyLocalResourceConflict("Another thread is using this working folder. Wait for it to finish.")).toEqual({ kind: "resource-busy", resource: "working-folder" });
    expect(classifyLocalResourceConflict(" Another thread is using this computer. Wait for it to finish.\n")).toEqual({ kind: "resource-busy", resource: "computer" });
    expect(classifyLocalResourceConflict("Another thread is using this browser profile. Wait for it to finish.")).toEqual({ kind: "resource-busy", resource: "browser" });
    expect(classifyLocalResourceConflict("Another thread is using this browser, computer or working folder.")).toEqual({ kind: "resource-busy", resource: "shared" });
  });
  it("does not let engine text, lookalikes or malformed saved messages borrow the wait card", () => {
    const message = "Another thread is using this computer. Wait for it to finish.";
    expect(classifyLocalResourceConflict(message, message)).toBeUndefined();
    expect(classifyLocalResourceConflict(message + " Check your API key.")).toBeUndefined();
    expect(classifyLocalResourceConflict("another thread is using this computer. wait for it to finish.")).toBeUndefined();
    expect(classifyLocalResourceConflict("constructor")).toBeUndefined();
    expect(classifyLocalResourceConflict(undefined)).toBeUndefined();
    expect(classifyLocalResourceConflict({ message })).toBeUndefined();
  });
});

describe("safe provider error details", () => {
  it("identifies observed Flux credit rejection without carrying response secrets or URLs", () => {
    const error = { data: { http_status: 402, message: "Your credit balance is exhausted. Top up at https://fluxrouter.ai/home/billing?token=fake-secret-canary" } };
    const info = classifyProviderError(error)!;
    expect(info).toEqual({ kind: "credits", provider: "flux-router", httpStatus: 402 });
    const display = providerErrorPresentation(info);
    expect(display.billingUrl).toBe("https://fluxrouter.ai/home/billing");
    expect(display.resolution).toContain("already added credits");
    expect(JSON.stringify({ info, display })).not.toContain("fake-secret-canary");
  });
  it("keeps authentication, permission, rate and outage failures distinct", () => {
    for (const [http_status, kind] of [[401, "authentication"], [403, "permission"], [429, "rate-limit"], [503, "unavailable"]] as const) {
      const info = classifyProviderError({ data: { http_status, message: "private fake-secret-canary" } })!;
      expect(info.kind).toBe(kind);
      expect(JSON.stringify(providerErrorPresentation(info))).not.toContain("fake-secret-canary");
      expect(providerErrorPresentation(info).billingUrl).toBeUndefined();
    }
    expect(classifyProviderError({ data: { http_status: "402", message: "credit balance is exhausted" } })).toBeUndefined();
    expect(classifyProviderError({ data: { http_status: 402, message: "unknown failure" } })).toEqual({kind:"payment",httpStatus:402});
    expect(classifyProviderError({ data: { http_status: 500, message: "credit balance is exhausted" } })).toBeUndefined();
  });
  it("classifies numeric402 without proven credit exhaustion as generic payment without provider or billing links",()=>{
    for(const message of [undefined,null,42,{},"unknown failure","private fake-secret-canary https://billing.invalid/private","Account access unavailable https://fluxrouter.ai/home/billing?token=fake-secret-canary"]){
      const info=classifyProviderError({data:{http_status:402,message}})!;
      expect(info).toEqual({kind:"payment",httpStatus:402});
      const display=providerErrorPresentation(info);
      expect(display).toEqual({title:"Provider payment or account access required",summary:"The provider rejected this request with HTTP 402. This response does not establish that credits are exhausted.",resolution:"Check the provider's billing, account and selected-model access, including bring-your-own-key (BYOK) settings, before retrying."});
      expect(JSON.stringify({info,display})).not.toMatch(/fake-secret-canary|billing\.invalid|fluxrouter\.ai/);
    }
    expect(providerErrorPresentation({kind:"payment",httpStatus:402,provider:"flux-router"}).billingUrl).toBeUndefined();
    for(const status of ["402",402.1,NaN,Infinity,null,undefined,400,500])expect(classifyProviderError({data:{http_status:status,message:"credit balance is exhausted"}})).toBeUndefined();
  });
  // Observed live against api.fluxrouter.ai on 2026-09-20 with a working key:
  // GET /v1/models answered 200 with the full catalog, while every completion
  // answered 402. The account was not out of credits and adding credit could
  // not have helped, so the "needs credits" card was both wrong and unusable.
  it("separates a monthly spending limit from running out of credits", () => {
    const shapes = [
      // The ACP/Fuigo path, which wraps the provider's sentence in its own.
      "API error (status 402 Payment Required): This account has reached its $10.00 monthly spend ceiling. The ceiling rises automatically as your account builds payment history — adding credit will not lift it. Email support@fluxrouter.ai if you need it raised sooner.",
      // The OpenAI-compatible path, where the machine code IS the message.
      "account_monthly_budget_exhausted",
      // The Anthropic-compatible path, which sends the sentence alone.
      "This account has reached its $10.00 monthly spend ceiling. The ceiling rises automatically as your account builds payment history — adding credit will not lift it.",
    ];
    for (const message of shapes) {
      const info = classifyProviderError({ data: { http_status: 402, message } })!;
      expect(info.kind).toBe("spend-cap");
      expect(info.httpStatus).toBe(402);
      const display = providerErrorPresentation(info);
      // The one thing this card must never do: send someone to buy credit to
      // lift a ceiling that credit does not lift. It must say the opposite,
      // and it must not offer the credits card's advice or its billing link.
      expect(display.resolution).toMatch(/adding credit will not lift it/i);
      expect(display.resolution).not.toMatch(/already added credits|add credits in/i);
      expect(display.billingUrl).toBeUndefined();
      expect(display.resolution).toMatch(/payment history/i);
      // Provider text names a sum and an account; neither belongs in the card.
      expect(JSON.stringify(display)).not.toMatch(/\$10|support@|fluxrouter/i);
    }
  });
  it("names Flux Router as the source only when the message carries a fluxrouter.ai locator", () => {
    const capped = "This account has reached its $10.00 monthly spend ceiling. Email support@fluxrouter.ai if you need it raised sooner.";
    expect(classifyProviderError({ data: { http_status: 402, message: capped } })!.provider).toBe("flux-router");
    expect(classifyProviderError({ data: { http_status: 402, message: "account_monthly_budget_exhausted" } })!.provider).toBeUndefined();
    for (const lookalike of ["support@fluxrouter.ai.evil.invalid", "support@notfluxrouter.ai", "fluxrouter.ai"]) {
      const info = classifyProviderError({ data: { http_status: 402, message: `monthly spend ceiling reached. ${lookalike}` } })!;
      expect(info.kind).toBe("spend-cap");
      expect(info.provider).toBeUndefined();
    }
  });
  it("still treats a real exhausted balance as credits and an unexplained 402 as payment", () => {
    expect(classifyProviderError({ data: { http_status: 402, message: "Your credit balance is exhausted." } })!.kind).toBe("credits");
    expect(classifyProviderError({ data: { http_status: 402, message: "unknown failure" } })!.kind).toBe("payment");
    expect(classifyProviderError({ data: { http_status: 500, message: "monthly spend ceiling" } })).toBeUndefined();
  });
  it("does not trust lookalike or embedded provider URLs", () => {
    for (const url of ["https://fluxrouter.ai.evil.invalid/", "https://fluxrouter.ai@evil.invalid/", "https://evil.invalid/https://fluxrouter.ai/home/billing"]) {
      const info = classifyProviderError({ data: { http_status: 402, message: `Your credit balance is exhausted. ${url}` } })!;
      expect(info.provider).toBeUndefined();
      expect(providerErrorPresentation(info).billingUrl).toBeUndefined();
    }
  });
  it("keeps malformed saved metadata on fixed fallback copy without a billing URL", () => {
    const presentation = providerErrorPresentation({ kind: "fake-secret-canary", billingUrl: "https://evil.invalid" } as unknown as ProviderErrorInfo);
    expect(presentation.title).toBe("Provider request failed");
    expect(presentation.billingUrl).toBeUndefined();
    expect(JSON.stringify(presentation)).not.toMatch(/fake-secret-canary|evil\.invalid/);
  });
});

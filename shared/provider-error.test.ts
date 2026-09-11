import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyLocalResourceConflict, classifyProviderError, LOCAL_RESOURCE_BUSY_MESSAGES, providerErrorPresentation, type ProviderErrorInfo } from "./provider-error.ts";

describe("local resource contention", () => {
  it("recognizes exactly the refusal copy the server throws for held leases", () => {
    const thrown = ["../server/index.ts", "../server/independent-thread-runs.ts"].flatMap((file) =>
      [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/"(Another thread is using [^"]+)"/g)].map((match) => match[1]));
    expect(new Set(thrown)).toEqual(new Set(LOCAL_RESOURCE_BUSY_MESSAGES.keys()));
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
    expect(classifyProviderError({ data: { http_status: 402, message: "unknown failure" } })).toBeUndefined();
    expect(classifyProviderError({ data: { http_status: 500, message: "credit balance is exhausted" } })).toBeUndefined();
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

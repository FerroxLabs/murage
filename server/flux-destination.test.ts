import { describe, expect, it } from "vitest";
import {
  fluxDestination,
  FLUX_DESTINATION_ALIAS_REFUSAL,
  FLUX_DESTINATION_UNKNOWN_REFUSAL,
} from "./flux-destination.ts";

describe("effective Flux destination", () => {
  it("refuses a Flux URL under an alias", () => {
    expect(fluxDestination({ provider: "router", urls: ["https://api.fluxrouter.ai/v1"] }, "flux")).toBe("refuse-alias");
  });

  it("uses the shared DNS host rule for every URL", () => {
    expect(fluxDestination({ provider: "router", urls: ["https://example.test/v1", "https://api.fluxrouter.ai./v1"] }, "flux")).toBe("refuse-alias");
    expect(fluxDestination({ provider: "flux", urls: ["https://api.fluxrouter.ai./v1"] }, "flux")).toBe("connector");
    expect(fluxDestination({ provider: "router", urls: ["https://api.fluxrouter.ai.example.test/v1"] }, "flux")).toBe("other");
  });

  it("judges the connector's actual URL too", () => {
    expect(fluxDestination({ provider: "flux", urls: ["https://example.test/v1"] }, "flux")).toBe("other");
  });

  it.each([
    ["https://example.com/v1", "other"],
    ["", "connector"],
    ["https://api.fluxrouter.ai/v1", "connector"],
  ])("judges empty baseURL plus %s as %s", (api, expected) => {
    expect(fluxDestination({ provider: "flux", urls: ["", api] }, "flux")).toBe(expected);
    expect(fluxDestination({ provider: "flux", urls: [api, ""] }, "flux")).toBe(expected);
  });

  it.each([null, undefined, 3, {}, [], "api.fluxrouter.ai/v1", "{env:URL}", "https://example.test/{file:url}", "***"])("refuses an unknown URL %j", (url) => {
    expect(fluxDestination({ provider: "router", urls: [url] }, "flux")).toBe("refuse-unknown");
  });

  it("refuses unknown fields even beside a known Flux URL", () => {
    expect(fluxDestination({ provider: "flux", urls: ["https://api.fluxrouter.ai/v1", null] }, "flux")).toBe("refuse-unknown");
    expect(fluxDestination({ unknown: "probe failed" }, "flux")).toBe("refuse-unknown");
    expect(fluxDestination({ provider: "", urls: [] }, "flux")).toBe("refuse-unknown");
  });

  it("judges an empty or absent URL by provider default", () => {
    for (const urls of [[], [""]]) {
      expect(fluxDestination({ provider: "flux", urls }, "flux")).toBe("connector");
      expect(fluxDestination({ provider: "native", urls }, "flux")).toBe("other");
    }
  });

  it("keeps both refusal messages inside the direct-send error limit", () => {
    expect(FLUX_DESTINATION_ALIAS_REFUSAL.length).toBeLessThanOrEqual(160);
    expect(FLUX_DESTINATION_UNKNOWN_REFUSAL.length).toBeLessThanOrEqual(160);
  });
});

it("names a failed probe's installed version without echoing arbitrary output", async () => {
  const { fluxDestinationUnknownRefusal, FLUX_DESTINATION_UNKNOWN_REFUSAL } = await import("./flux-destination.ts");
  expect(fluxDestinationUnknownRefusal("1.15.11")).toContain("OpenCode 1.15.11");
  expect(fluxDestinationUnknownRefusal("1.15.11").length).toBeLessThanOrEqual(160);
  expect(fluxDestinationUnknownRefusal("private output")).toBe(FLUX_DESTINATION_UNKNOWN_REFUSAL);
});

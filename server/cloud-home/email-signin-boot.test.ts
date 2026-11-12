import { describe, expect, it, vi } from "vitest";
import { createHomeSupervisorSession } from "./supervisor-session.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import { stubFluxDeviceCodeClient, type FluxDeviceCodeClient } from "./email-owner-signin.ts";

const sessionOptions = (extra: object) => ({
  store: { getAll: () => ({}), patch: () => ({}), close: () => {} }, bootstrapSecret: "fixture", ...extra,
});
const capabilities = {
  device_authorization_grant: true, bot_keys: true, client_id: "murage-cloud", scope: "email:owner",
  grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_authorization_endpoint: "/api/device/code", token_endpoint: "/api/device/token",
};

describe("production owner sign-in client wiring", () => {
  it("constructs the real client with the existing Flux origin and injected fetch", async () => {
    let client: FluxDeviceCodeClient | undefined;
    const fetcher = vi.fn(async (url: string | URL | Request) => Response.json(String(url).endsWith("capabilities") ? capabilities : {
      device_code: "private-code", user_code: "CODE-123", verification_uri: "/device", interval: 5, expires_in: 60,
    }));
    const portFactory = (opts: Parameters<typeof createSupervisorPort>[0]) => { client = opts.emailDeviceCode; return createSupervisorPort(opts); };
    const session = createHomeSupervisorSession(sessionOptions({ fluxBaseUrl: "https://fluxrouter.ai", fetch: fetcher, portFactory }));
    try {
      expect(client).toBeDefined();
      expect(client).not.toBe(stubFluxDeviceCodeClient);
      expect(await client!.start()).toMatchObject({ userCode: "CODE-123", verificationUrl: "https://fluxrouter.ai/device" });
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://fluxrouter.ai/api/device/capabilities", "https://fluxrouter.ai/api/device/code"]);
    } finally { session.close(); }
  });
  it("passes the stub explicitly when the home has no Flux origin", () => {
    const portFactory = vi.fn(createSupervisorPort);
    const session = createHomeSupervisorSession(sessionOptions({ portFactory }));
    try { expect(portFactory.mock.calls[0]![0].emailDeviceCode).toBe(stubFluxDeviceCodeClient); }
    finally { session.close(); }
  });
  it("the production supervisor uses the app device base with recorded responses", async () => {
    const { createHomeEmailSupervisorSession } = await import("./supervisor.ts");
    const { FLUX_DEVICE_BASE } = await import("../flux-routing.ts");
    const { recordedCapabilities, recordedCode } = await import("./flux-device-fixtures.ts");
    let client: FluxDeviceCodeClient | undefined;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.origin !== FLUX_DEVICE_BASE) return Response.json({ error: "unsupported_endpoint" }, { status: 404 });
      return Response.json(url.pathname.endsWith("capabilities") ? recordedCapabilities(FLUX_DEVICE_BASE) : recordedCode(FLUX_DEVICE_BASE));
    });
    const portFactory = (opts: Parameters<typeof createSupervisorPort>[0]) => { client = opts.emailDeviceCode; return createSupervisorPort(opts); };
    const session = createHomeEmailSupervisorSession(sessionOptions({ fetch: fetcher, portFactory }));
    try {
      expect(FLUX_DEVICE_BASE).toBe("https://fluxrouter.ai");
      expect(await client!.start()).toMatchObject({ userCode: "ABCD-1234", verificationUrl: `${FLUX_DEVICE_BASE}/device?user_code=ABCD-1234` });
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${FLUX_DEVICE_BASE}/api/device/capabilities`, `${FLUX_DEVICE_BASE}/api/device/code`]);
    } finally { session.close(); }
  });
});

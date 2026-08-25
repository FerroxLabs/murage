import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneError,
  createControlPlaneClient,
  normalizeAccountEmail,
  normalizeControlPlaneURL,
} from "./control-plane-client.mjs";

const ACCOUNT = `signed.${"a".repeat(40)}`;
const INSTALL = `omb_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const INSTALL_ID = "11111111-1111-4111-8111-111111111111";
const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });

describe("control-plane desktop client", () => {
  it("accepts exact HTTPS and loopback development origins only", () => {
    expect(normalizeControlPlaneURL("https://accounts.openmausbot.com/")).toBe(
      "https://accounts.openmausbot.com",
    );
    expect(normalizeControlPlaneURL("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeControlPlaneURL("http://accounts.openmausbot.com")).toBe("");
    expect(normalizeControlPlaneURL("https://accounts.openmausbot.com/api")).toBe("");
    expect(normalizeControlPlaneURL("https://user:secret@accounts.openmausbot.com")).toBe("");
  });

  it("normalizes an email without accepting malformed input", () => {
    expect(normalizeAccountEmail(" Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeAccountEmail("not-an-email")).toBe("");
  });

  it("uses the signed Better Auth bearer header, never its raw JSON token", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(JSON.parse(init.body)).toEqual({
        email: "ada@example.com",
        otp: "12345678",
        name: "ada",
      });
      return jsonResponse(
        { token: "raw-database-token-must-not-be-used", user: { id: "user-1", email: "ada@example.com" } },
        { headers: { "set-auth-token": ACCOUNT } },
      );
    });
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl,
    });

    await expect(client.verifyOTP("Ada@Example.com", "1234-5678")).resolves.toEqual({
      accountToken: ACCOUNT,
      user: { id: "user-1", email: "ada@example.com" },
    });
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("raw-database-token-must-not-be-used");
  });

  it("keeps a valid installation credential without rotating it", async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/installations/self");
      return jsonResponse({
        installation: {
          id: INSTALL_ID,
          clientInstanceId: "client-1",
          name: "Mac",
          platform: "darwin",
          appVersion: "1.0.0",
        },
        credentialExpiresAt: Date.now() + 10_000,
      });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    const result = await client.ensureInstallation({
      accountToken: ACCOUNT,
      currentCredential: INSTALL,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    });
    expect(result.credential).toBe(INSTALL);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost installation credential by rotating the matching identity", async () => {
    const rotated = `omb_install_${"c".repeat(22)}.${"d".repeat(43)}`;
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/v1/installations")) {
        return jsonResponse({
          installations: [{ id: INSTALL_ID, clientInstanceId: "client-1", name: "Mac", platform: "darwin" }],
        });
      }
      expect(url).toContain(`/v1/installations/${INSTALL_ID}/credentials/rotate`);
      expect(init.method).toBe("POST");
      return jsonResponse({ credential: rotated, credentialExpiresAt: Date.now() + 10_000 }, { status: 201 });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.ensureInstallation({
      accountToken: ACCOUNT,
      clientInstanceId: "client-1",
      name: "Mac",
      platform: "darwin",
      appVersion: "1.0.0",
    })).resolves.toMatchObject({ credential: rotated, installation: { id: INSTALL_ID } });
  });

  it("validates endpoint material without leaking the connector token into the URL", async () => {
    const connectorToken = `eyJ${"x".repeat(80)}`;
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe("https://accounts.openmausbot.com/v1/installations/self/endpoint");
      expect(init.headers.get("authorization")).toBe(`Bearer ${INSTALL}`);
      expect(url).not.toContain(connectorToken);
      return jsonResponse({ endpoint: { url: "https://c-opaque.openmausbot.com" }, connectorToken });
    });
    const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com", fetchImpl });
    await expect(client.ensureEndpoint(INSTALL)).resolves.toEqual({
      endpoint: { url: "https://c-opaque.openmausbot.com" },
      connectorToken,
    });
  });

  it("maps bounded server error codes and hides arbitrary response text", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => jsonResponse({ error: "rate_limited", detail: "secret detail" }, { status: 429 })),
    });
    await expect(client.requestOTP("ada@example.com")).rejects.toMatchObject({
      name: "ControlPlaneError",
      code: "rate_limited",
      status: 429,
    });
  });

  it("fails closed on redirects and network errors", async () => {
    const client = createControlPlaneClient({
      baseURL: "https://accounts.openmausbot.com",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("redirect blocked");
      }),
    });
    await expect(client.requestOTP("ada@example.com")).rejects.toEqual(
      expect.objectContaining({ code: "network_unavailable" }),
    );
    expect(() => createControlPlaneClient({ baseURL: "http://remote.example" })).toThrow(
      ControlPlaneError,
    );
  });
});

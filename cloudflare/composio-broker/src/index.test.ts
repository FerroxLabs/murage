import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstallationRow } from "./index";
import {
  authorize,
  billableCallCount,
  catalog,
  confirmClaim,
  configuredInstant,
  issueClaim,
  migrationGate,
  route,
  signClaimAssertion,
  connectedServices,
  connectionStatus,
  createSession,
  disconnectAccount,
  ensureSession,
  normalizeAccountAlias,
  parseSession,
  proxyMcp,
  readBoundedBody,
  register,
  registrationActorKey,
  requestAlias,
  sha256,
} from "./index";

const multiAccount = {
  enable: true,
  max_accounts_per_toolkit: 5,
  require_explicit_selection: true,
};

/** An installations row the way `authenticate` returns it. The claim columns
 * are null for every install that has never been offered to FluxRouter, which
 * is what the whole existing fleet looks like. */
function installRow(overrides: Partial<InstallationRow> = {}): InstallationRow {
  return {
    id: "install-1",
    composio_user_id: "murage_stable",
    session_id: "trs_multi",
    disabled_at: null,
    claim_issued_at: null,
    claim_confirmed_at: null,
    last_claim_jti: null,
    ...overrides,
  };
}

function session(id: string, userId: string, configured = true) {
  return {
    session_id: id,
    mcp: { url: `https://mcp.composio.dev/${id}` },
    config: { user_id: userId, ...(configured ? { multi_account: multiAccount } : {}) },
  };
}

function testEnv(fetchCalls: Array<{ url: string; init?: RequestInit }>) {
  const dbRuns: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    COMPOSIO_API_BASE: "https://backend.composio.dev/api/v3.1",
    COMPOSIO_API_KEY: "ak_test",
    SESSION_LIMITER: { limit: async () => ({ success: true }) },
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              run: async () => {
                dbRuns.push({ sql, values });
              },
            };
          },
        };
      },
    },
  };
  const ctx = { waitUntil(promise: Promise<unknown>) { void promise; } };
  return { env, ctx, dbRuns, fetchCalls };
}

afterEach(() => vi.unstubAllGlobals());

describe("connected-apps broker boundaries", () => {
  it("forwards only bounded catalog cursors and fixes page parameters", async () => {
    const calls: string[] = [];
    const { env } = testEnv([]);
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json({ items: [] });
    });
    const catalogEnv = { ...env, COMPOSIO_TOOLKIT_BASE: "https://backend.composio.dev/api/v3" } as never;
    for (const cursor of [null, "page+2/==", " &limit=1", "a".repeat(257)]) {
      const url = new URL("https://broker.example.test/v1/catalog?limit=1&sort_by=secret");
      if (cursor) url.searchParams.set("cursor", cursor);
      await catalog(catalogEnv, url);
    }
    expect(calls.map(value => new URL(value).searchParams.get("cursor"))).toEqual([null, "page+2/==", null, null]);
    for (const value of calls) {
      expect(new URL(value).searchParams.get("limit")).toBe("500");
      expect(new URL(value).searchParams.get("sort_by")).toBe("usage");
    }
  });

  it("accepts an empty authorize body as a first-account request", async () => {
    await expect(requestAlias(new Request("https://broker.test/v1/connectors/gmail/authorize", {
      method: "POST",
      body: "",
    }))).resolves.toBeUndefined();
    await expect(requestAlias(new Request("https://broker.test/v1/connectors/gmail/authorize", {
      method: "POST",
      body: "  \n",
    }))).resolves.toBeUndefined();
  });

  it("accepts only HTTPS Composio MCP endpoints", () => {
    expect(parseSession({
      session_id: "session-1",
      mcp: { url: "https://mcp.composio.dev/session", headers: { "x-session": "one", host: "bad" } },
    })).toEqual({
      sessionId: "session-1",
      url: "https://mcp.composio.dev/session",
      headers: { "x-session": "one" },
      userId: undefined,
      multiAccountConfigured: false,
    });
    expect(() => parseSession({ session_id: "session-1", mcp: { url: "https://attacker.example/mcp" } })).toThrow(/untrusted/i);
    expect(() => parseSession({ session_id: "session-1", mcp: { url: "http://mcp.composio.dev/session" } })).toThrow(/untrusted/i);
  });

  it("hashes installation tokens before storage", async () => {
    await expect(sha256("murage")).resolves.toBe("1f786e39759052a297ad09530939c247b5cd167c21445b5323d84b628dc7c087");
  });

  it("creates Sessions with explicit multi-account selection", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Response.json(session("trs_new", "murage_user"), { status: 201 });
    });

    await expect(createSession(env as never, "murage_user")).resolves.toMatchObject({
      sessionId: "trs_new",
      multiAccountConfigured: true,
    });
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toMatchObject({
      user_id: "murage_user",
      multi_account: multiAccount,
    });
  });

  it("upgrades a legacy Session without changing the installation's Composio user", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx, dbRuns } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (init?.method === "POST") return Response.json(session("trs_new", "murage_stable"), { status: 201 });
      return Response.json(session("trs_legacy", "murage_stable", false));
    });

    await expect(ensureSession(installRow({ session_id: "trs_legacy" }), env as never, ctx as never)).resolves.toMatchObject({ sessionId: "trs_new", multiAccountConfigured: true });
    const creation = fetchCalls.find((call) => call.init?.method === "POST");
    expect(JSON.parse(String(creation?.init?.body))).toMatchObject({ user_id: "murage_stable", multi_account: multiAccount });
    expect(dbRuns.some((run) => run.values[0] === "trs_new" && run.values[2] === "install-1")).toBe(true);
  });

  it("returns every account and deletes only an owned account ID", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls);
    const accounts = {
      items: [
        { id: "ca_work", alias: "work", toolkit: { slug: "gmail" }, status: "ACTIVE", updated_at: "2026-08-21T10:00:00Z" },
        { id: "ca_personal", alias: "personal", toolkit: { slug: "gmail" }, status: "INITIALIZING", updated_at: "2026-08-21T11:00:00Z" },
      ],
      next_cursor: "accounts-page-2",
    };
    let connectedAccountsUnavailable = false;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.includes("/tool_router/session/trs_multi/toolkits")) {
        const query = new URL(url).searchParams;
        if (query.get("cursor") === "toolkits-page-2") {
          return Response.json({
            items: [
              { slug: "publicsearch", is_no_auth: true },
              { slug: "selectedonly", connected_account: { id: "ca_session_only", status: "ACTIVE" } },
            ],
          });
        }
        const body = {
          items: [
            { slug: "gmail", connected_account: { id: "ca_work", status: "ACTIVE" } },
            { slug: "unconnected", connected_account: null },
          ],
          next_cursor: query.has("toolkits") ? undefined : "toolkits-page-2",
        };
        return Response.json(body);
      }
      if (url.endsWith("/tool_router/session/trs_multi/link") && init?.method === "POST") {
        return Response.json({ redirect_url: "https://connect.composio.dev/link/gmail" }, { status: 201 });
      }
      if (url.includes("/tool_router/session/trs_multi")) return Response.json(session("trs_multi", "murage_stable"));
      if (url.includes("/connected_accounts?") && !init?.method) {
        if (connectedAccountsUnavailable) {
          return Response.json({ error: "connected-account read not granted" }, { status: 403 });
        }
        if (url.includes("cursor=accounts-page-2")) {
          return Response.json({
            items: [
              { id: "ca_toolkit_41", alias: "overflow", toolkit: { slug: "toolkit_41" }, status: "ACTIVE", updated_at: "2026-08-21T12:00:00Z" },
            ],
          });
        }
        return Response.json(accounts);
      }
      if (url.includes("/connected_accounts/ca_work") && init?.method === "DELETE") return Response.json({ success: true });
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const installation = installRow();

    const statusResponse = await connectionStatus(
      new URL("https://broker.example/v1/connectors?services=gmail"),
      installation,
      env as never,
      ctx as never,
    );
    await expect(statusResponse.json()).resolves.toEqual({
      services: {
        gmail: {
          connected: true,
          pending: true,
          status: "ACTIVE",
          accounts: [
            { id: "ca_personal", alias: "personal", status: "INITIALIZING" },
            { id: "ca_work", alias: "work", status: "ACTIVE" },
          ],
        },
      },
    });
    const connectedResponse = await connectedServices(installation, env as never, ctx as never);
    await expect(connectedResponse.json()).resolves.toMatchObject({
      configured: true,
      services: {
        toolkit_41: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_toolkit_41", alias: "overflow", status: "ACTIVE" }],
        },
        publicsearch: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [],
        },
        selectedonly: {
          connected: true,
          pending: false,
          status: "ACTIVE",
          accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
        },
      },
    });
    const inventoryCall = fetchCalls.find((call) =>
      call.url.includes("/connected_accounts?") && !call.url.includes("toolkit_slugs=")
    );
    expect(inventoryCall).toBeDefined();
    expect(fetchCalls.some((call) =>
      call.url.includes("/connected_accounts?")
        && !call.url.includes("toolkit_slugs=")
        && call.url.includes("cursor=accounts-page-2")
    )).toBe(true);
    expect(fetchCalls.some((call) =>
      call.url.includes("/tool_router/session/trs_multi/toolkits?")
        && !call.url.includes("toolkits=")
        && call.url.includes("is_connected=true")
        && call.url.includes("cursor=toolkits-page-2")
    )).toBe(true);

    connectedAccountsUnavailable = true;
    const fallbackResponse = await connectedServices(installation, env as never, ctx as never);
    await expect(fallbackResponse.json()).resolves.toMatchObject({
      configured: true,
      services: {
        gmail: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_work", status: "ACTIVE" }],
        },
        publicsearch: { connected: true, status: "ACTIVE", accounts: [] },
        selectedonly: {
          connected: true,
          status: "ACTIVE",
          accounts: [{ id: "ca_session_only", status: "ACTIVE" }],
        },
      },
    });
    connectedAccountsUnavailable = false;
    await expect((await disconnectAccount("gmail", "ca_work", installation, env as never, ctx as never)).json())
      .resolves.toEqual({ removed: 1 });
    await expect((await disconnectAccount("gmail", "ca_not_owned", installation, env as never, ctx as never)).json())
      .resolves.toEqual({ removed: 0 });
    expect(fetchCalls.filter((call) => call.init?.method === "DELETE")).toHaveLength(1);

    const missingAlias = await authorize("gmail", undefined, installation, env as never, ctx as never);
    expect(missingAlias.status).toBe(400);
    await expect(missingAlias.json()).resolves.toEqual({
      error: "Add an account alias so the existing connection is not replaced",
    });
    const authorized = await authorize("gmail", "second", installation, env as never, ctx as never);
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({ url: "https://connect.composio.dev/link/gmail" });
    const linkCall = fetchCalls.find((call) => call.url.endsWith("/tool_router/session/trs_multi/link"));
    expect(JSON.parse(String(linkCall?.init?.body))).toEqual({ toolkit: "gmail", alias: "second" });
  });

  it("validates aliases at the broker boundary", () => {
    expect(normalizeAccountAlias("  work gmail  ")).toBe("work gmail");
    expect(() => normalizeAccountAlias("bad\nalias")).toThrow(/printable/i);
  });
});

describe("registration throttling identity", () => {
  function registrationRequest(ip: string | null, userAgent: string) {
    const headers = new Headers({ "user-agent": userAgent });
    if (ip !== null) headers.set("cf-connecting-ip", ip);
    return new Request("https://broker.test/v1/installations", { method: "POST", headers });
  }

  function registrationEnv(limit: number) {
    const buckets = new Map<string, number>();
    const inserts: unknown[][] = [];
    const env = {
      REGISTRATION_MODE: "open",
      REGISTRATION_LIMITER: {
        async limit({ key }: { key: string }) {
          const used = (buckets.get(key) ?? 0) + 1;
          buckets.set(key, used);
          return { success: used <= limit };
        },
      },
      DB: {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              return {
                run: async () => {
                  if (sql.startsWith("INSERT INTO installations")) inserts.push(values);
                },
              };
            },
          };
        },
      },
    };
    return { buckets, env, inserts };
  }

  it("ignores User-Agent and bounds one source address across many User-Agents", async () => {
    const { buckets, env, inserts } = registrationEnv(30);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const statuses: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      const response = await register(registrationRequest("203.0.113.7", `agent-${index}`), env as never);
      statuses.push(response.status);
    }
    expect(statuses.filter((status) => status === 201)).toHaveLength(30);
    expect(statuses.slice(30).every((status) => status === 429)).toBe(true);
    expect(inserts).toHaveLength(30);
    expect(buckets.size).toBe(1);

    // An independent legitimate actor keeps its own bucket.
    const other = await register(registrationRequest("198.51.100.23", "agent-0"), env as never);
    expect(other.status).toBe(201);
    expect(buckets.size).toBe(2);
    vi.restoreAllMocks();
  });

  it("keys IPv4 exactly, IPv6 by /64 and IPv4-mapped IPv6 as IPv4", () => {
    const key = (ip: string | null, userAgent = "ua") => registrationActorKey(registrationRequest(ip, userAgent));
    expect(key("203.0.113.7", "curl/8")).toBe(key("203.0.113.7", "Mozilla/5.0"));
    expect(key("203.0.113.7")).toBe("ip4:203.0.113.7");
    expect(key("203.0.113.8")).not.toBe(key("203.0.113.7"));
    expect(key("::ffff:203.0.113.7")).toBe("ip4:203.0.113.7");
    expect(key("::FFFF:cb00:7107")).toBe("ip4:203.0.113.7");

    const sameSubnet = [
      "2001:db8:1234:5678::1",
      "2001:0db8:1234:5678:aaaa:bbbb:cccc:dddd",
      "2001:DB8:1234:5678:0:0:0:ffff",
      "2001:db8:1234:5678::1%eth0",
    ].map((ip) => key(ip));
    expect(new Set(sameSubnet)).toEqual(new Set(["ip6:2001:0db8:1234:5678::/64"]));
    expect(key("2001:db8:1234:5679::1")).not.toBe(sameSubnet[0]);
    expect(key("::1")).toBe("ip6:0000:0000:0000:0000::/64");

    // Missing or malformed edge identity shares one fail-closed bucket rather
    // than falling back to a client-chosen header.
    for (const invalid of [null, "", "unknown", "300.1.1.1", "2001:db8::1::2", "1:2:3:4:5:6:7:8:9", "x".repeat(80)]) {
      expect(key(invalid, `agent-${String(invalid)}`)).toBe("ip:unknown");
    }
  });

  it("keeps the registration kill switch ahead of the limiter", async () => {
    const { buckets, env, inserts } = registrationEnv(30);
    const closed = await register(registrationRequest("203.0.113.7", "ua"), { ...env, REGISTRATION_MODE: "closed" } as never);
    expect(closed.status).toBe(503);
    expect(buckets.size).toBe(0);
    expect(inserts).toHaveLength(0);
  });
});

describe("bounded request bodies", () => {
  const KiB = 1024;
  const MiB = 1024 * KiB;
  const mcpBounds = { maxBytes: 2 * MiB, deadlineMs: 1_000, tooLargeMessage: "MCP request is too large" };

  /** highWaterMark 0: the source is pulled only when the reader asks, so
   *  `pulls` is exactly the number of chunks the broker consumed. */
  function countingStream(chunkBytes: number, chunkCount: number) {
    const state = { pulls: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulls >= chunkCount) {
          controller.close();
          return;
        }
        state.pulls += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        state.cancelled = true;
      },
    }, { highWaterMark: 0 });
    return { state, stream };
  }

  function bodyRequest(stream: ReadableStream<Uint8Array> | null, contentLength?: string) {
    const headers = new Headers();
    if (contentLength !== undefined) headers.set("content-length", contentLength);
    return { body: stream, headers } as unknown as Request;
  }

  async function rejectionOf(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Response);
    return error as Response;
  }

  it("stops an undeclared MCP body at 2 MiB and cancels before the oversized tail", async () => {
    const { state, stream } = countingStream(512 * KiB, 16);
    const response = await rejectionOf(readBoundedBody(bodyRequest(stream), mcpBounds));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "MCP request is too large" });
    // 5 x 512 KiB is the first read past the cap; the remaining 11 chunks are never pulled.
    expect(state.pulls).toBe(5);
    expect(state.cancelled).toBe(true);
  });

  it("accepts a body of exactly the cap and an empty body", async () => {
    const exact = countingStream(512 * KiB, 4);
    await expect(readBoundedBody(bodyRequest(exact.stream), mcpBounds)).resolves.toHaveLength(2 * MiB);
    expect(exact.state.cancelled).toBe(false);
    await expect(readBoundedBody(bodyRequest(null), mcpBounds)).resolves.toHaveLength(0);
    await expect(readBoundedBody(bodyRequest(countingStream(1, 0).stream, "0"), mcpBounds)).resolves.toHaveLength(0);
  });

  it("refuses an over-cap or malformed declared length before reading any bytes", async () => {
    const declared = countingStream(512 * KiB, 16);
    const tooLarge = await rejectionOf(readBoundedBody(bodyRequest(declared.stream, String(2 * MiB + 1)), mcpBounds));
    expect(tooLarge.status).toBe(413);
    expect(declared.state.pulls).toBe(0);
    expect((await rejectionOf(readBoundedBody(bodyRequest(null, "9".repeat(40)), mcpBounds))).status).toBe(413);

    for (const malformed of ["abc", "-1", "1e3", "12, 12", ""]) {
      const stream = countingStream(KiB, 1);
      const response = await rejectionOf(readBoundedBody(bodyRequest(stream.stream, malformed), mcpBounds));
      expect(response.status, malformed).toBe(400);
      expect(stream.state.pulls, malformed).toBe(0);
    }
  });

  it("counts actual bytes when the declared length understates the body", async () => {
    const { state, stream } = countingStream(KiB, 8);
    const response = await rejectionOf(readBoundedBody(bodyRequest(stream, "10"), {
      maxBytes: 2 * KiB,
      deadlineMs: 1_000,
      tooLargeMessage: "request body is too large",
    }));
    expect(response.status).toBe(413);
    expect(state.pulls).toBe(3);
    expect(state.cancelled).toBe(true);
  });

  it("fails a stalled upload at its read deadline and cancels it", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const response = await rejectionOf(readBoundedBody(bodyRequest(stalled), { ...mcpBounds, deadlineMs: 20 }));
    expect(response.status).toBe(408);
    expect(cancelled).toBe(true);
  });

  it("rejects an oversized chunked MCP request with 413 before charging or calling upstream", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls);
    const prepared: string[] = [];
    const spiedEnv = {
      ...env,
      DB: {
        prepare(sql: string) {
          prepared.push(sql);
          return env.DB.prepare(sql);
        },
      },
    };
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return Response.json({});
    });
    const { state, stream } = countingStream(512 * KiB, 16);
    const request = new Request("https://broker.test/v1/mcp", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const installation = installRow();

    const response = await proxyMcp(request, installation, spiedEnv as never, ctx as never);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "MCP request is too large" });
    expect(state.pulls).toBeLessThan(16);
    expect(state.cancelled).toBe(true);
    expect(fetchCalls).toHaveLength(0);
    expect(prepared).toHaveLength(0);
  });

  it("forwards a small MCP request's exact bytes upstream", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.includes("/tool_router/session/trs_multi")) return Response.json(session("trs_multi", "murage_stable"));
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    });
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const request = new Request("https://broker.test/v1/mcp", { method: "POST", body: payload });
    const installation = installRow();

    const response = await proxyMcp(request, installation, { ...env, DAILY_CALL_CEILING: "off" } as never, ctx as never);
    expect(response.status).toBe(200);
    const upstream = fetchCalls.find((call) => call.url === "https://mcp.composio.dev/trs_multi");
    expect(new TextDecoder().decode(upstream?.init?.body as Uint8Array)).toBe(payload);
  });

  it("keeps alias bodies within 2 KiB while valid aliases still parse", async () => {
    // A real chunked Request, so a whole-body read would pull every chunk.
    const { state, stream } = countingStream(KiB, 8);
    const oversized = await rejectionOf(requestAlias(new Request("https://broker.test/v1/connectors/gmail/authorize", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit)));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "request body is too large" });
    expect(state.pulls).toBeLessThan(8);
    expect(state.cancelled).toBe(true);

    await expect(requestAlias(new Request("https://broker.test/v1/connectors/gmail/authorize", {
      method: "POST",
      body: JSON.stringify({ alias: "  work  " }),
    }))).resolves.toBe("work");
    expect((await rejectionOf(requestAlias(new Request("https://broker.test/v1/connectors/gmail/authorize", {
      method: "POST",
      body: "{not json",
    })))).status).toBe(400);
  });
});

describe("write-safe account inventory for new links", () => {
  const installation = installRow();

  function linkHarness(inventory: () => Response) {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const { env, ctx } = testEnv(fetchCalls);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({ url, init });
      if (url.endsWith("/tool_router/session/trs_multi/link") && init?.method === "POST") {
        return Response.json({ redirect_url: "https://connect.composio.dev/link/gmail" }, { status: 201 });
      }
      if (url.includes("/tool_router/session/trs_multi")) return Response.json(session("trs_multi", "murage_stable"));
      if (url.includes("/connected_accounts?")) return inventory();
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const links = () => fetchCalls.filter((call) => call.url.endsWith("/link") && call.init?.method === "POST");
    const link = (alias?: string) => authorize("gmail", alias, installation, env as never, ctx as never);
    return { link, links };
  }

  const accountsPage = (...items: Array<Record<string, unknown>>) => () => Response.json({ items });

  it.each([
    ["403 denied list scope", () => Response.json({ error: "connected-account read not granted" }, { status: 403 })],
    ["503 outage", () => Response.json({ error: "temporarily unavailable" }, { status: 503 })],
    ["unreadable page", () => Response.json({ unexpected: true })],
  ])("refuses to create a link when the inventory fails (%s)", async (_label, inventory) => {
    const harness = linkHarness(inventory);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const alias of [undefined, "second"]) {
      const response = await harness.link(alias);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "Connected accounts could not be checked right now, so no new link was created. Try again in a moment.",
        code: "account_inventory_unavailable",
      });
    }
    expect(harness.links()).toHaveLength(0);
    expect(logged.mock.calls.flat().join(" ")).not.toContain("ak_test");
    logged.mockRestore();
  });

  it("keeps first, additional, pending, duplicate and capped link rules when the inventory succeeds", async () => {
    let inventory = accountsPage();
    const harness = linkHarness(() => inventory());

    const first = await harness.link();
    expect(first.status).toBe(200);
    expect(JSON.parse(String(harness.links()[0]?.init?.body))).toEqual({ toolkit: "gmail" });

    inventory = accountsPage({ id: "ca_work", alias: "work", toolkit: { slug: "gmail" }, status: "ACTIVE" });
    expect((await harness.link()).status).toBe(400);
    expect((await harness.link("Work")).status).toBe(409);
    const additional = await harness.link("second");
    expect(additional.status).toBe(200);
    expect(JSON.parse(String(harness.links().at(-1)?.init?.body))).toEqual({ toolkit: "gmail", alias: "second" });

    inventory = accountsPage({ id: "ca_pending", toolkit: { slug: "gmail" }, status: "INITIATED" });
    expect((await harness.link()).status).toBe(400);

    inventory = accountsPage(...Array.from({ length: 5 }, (_, index) => ({
      id: `ca_${index}`,
      alias: `account ${index}`,
      toolkit: { slug: "gmail" },
      status: "ACTIVE",
    })));
    expect((await harness.link("sixth")).status).toBe(409);
    expect(harness.links()).toHaveLength(2);
  });
});

// ── moving an install to FluxRouter ────────────────────────────────────
// The whole point of the three legs is that nothing destructive happens until
// the last one. These tests are written against that: an assertion that is
// signed and then dropped on the floor must leave the install exactly as it
// was, because the ways leg 2 can fail (FluxRouter 5xx, a paused claim route,
// a rate limit, no network) are all ordinary.

const CLAIM_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  d: "KSGQAa7uJcCVg4x3PCeSx8vdAhnbLBiuv5jU8k487gI",
  x: "FAcqeKx9x_BMTFpNjOEG2vA_i7ka60FBQAqMoGi3LUo",
  kid: "murage-claim-test",
};
const CLAIM_PUBLIC_JWK = { kty: "OKP", crv: "Ed25519", x: CLAIM_JWK.x };
const BROKER_TOKEN_HASH = "b".repeat(64);
const DAY_MS = 86_400_000;

function decodeSegment(segment: string): Record<string, unknown> {
  const padded = segment.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))));
}

/** Verify exactly as FluxRouter will: public key only, signature over the
 * signing input, nothing trusted from the payload until it checks out. */
async function verifyAssertion(assertion: string) {
  const [header, payload, signature] = assertion.split(".");
  const key = await crypto.subtle.importKey("jwk", CLAIM_PUBLIC_JWK, { name: "Ed25519" }, false, ["verify"]);
  const raw = signature.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(signature.length / 4) * 4, "=");
  const valid = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return { valid, header: decodeSegment(header), payload: decodeSegment(payload) };
}

/** A D1 stand-in that records every statement and answers `first()`, which the
 * claim routes and the call fuse both need. */
function claimEnv(overrides: Record<string, unknown> = {}, row: InstallationRow = installRow()) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const env = {
    COMPOSIO_API_KEY: "ak_test",
    CLAIM_MODE: "open",
    MIGRATION_GATE: "on",
    CLAIM_GRACE_SECONDS: "900",
    CLAIM_ISSUED_FALLBACK_SECONDS: "604800",
    LEGACY_BROKER_UNTIL: "",
    CLAIM_UNTIL: "",
    CLAIM_SIGNING_JWK: JSON.stringify(CLAIM_JWK),
    DAILY_CALL_CEILING: "off",
    SESSION_LIMITER: { limit: async () => ({ success: true }) },
    REGISTRATION_LIMITER: { limit: async () => ({ success: true }) },
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              run: async () => { statements.push({ sql, values }); },
              first: async () => { statements.push({ sql, values }); return row; },
            };
          },
        };
      },
    },
    ...overrides,
  };
  return { env, statements, ctx: { waitUntil(promise: Promise<unknown>) { void promise; } } };
}

const claimRequest = (body: unknown = { audience: "fluxrouter-composio", brokerTokenSha256: BROKER_TOKEN_HASH }) =>
  new Request("https://broker.test/v1/claims", { method: "POST", body: JSON.stringify(body) });

describe("issuing a claim assertion", () => {
  it("signs the stored Composio user id with a key FluxRouter only ever verifies", async () => {
    const { env, statements } = claimEnv();
    const response = await issueClaim(claimRequest(), installRow(), env as never);
    expect(response.status).toBe(200);
    const body = await response.json() as { assertion: string; jti: string; expiresAt: number };
    expect(body.jti).toMatch(/^[0-9a-f-]{36}$/);

    const { valid, header, payload } = await verifyAssertion(body.assertion);
    expect(valid).toBe(true);
    expect(header).toEqual({ alg: "EdDSA", typ: "murage-composio-claim+jwt", kid: "murage-claim-test" });
    expect(payload).toMatchObject({
      iss: "murage-composio",
      aud: "fluxrouter-composio",
      sub: "install-1",
      // From D1, never recomputed from anything the client sent.
      cuid: "murage_stable",
      bth: BROKER_TOKEN_HASH,
      jti: body.jti,
    });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(300);

    // Issuance records that it happened and remembers which assertion, so a
    // confirmation can only settle the one it belongs to.
    const update = statements.find((statement) => statement.sql.includes("claim_issued_at"));
    expect(update?.values).toContain(body.jti);
    expect(update?.sql).toContain("COALESCE(claim_issued_at");
    expect(update?.sql).not.toContain("claim_confirmed_at");
  });

  it("never stores or logs the broker-token hash it was given", async () => {
    const { env, statements } = claimEnv();
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const response = await issueClaim(claimRequest(), installRow(), env as never);
    expect(response.status).toBe(200);
    expect(JSON.stringify(statements)).not.toContain(BROKER_TOKEN_HASH);
    const lines = logged.mock.calls.flat().join(" ");
    expect(lines).toContain("claim issued");
    expect(lines).not.toContain(BROKER_TOKEN_HASH);
    // Nor the assertion itself: it is a bearer credential for five minutes.
    expect(lines).not.toContain("eyJ");
    logged.mockRestore();
  });

  it.each([
    ["a foreign audience", { audience: "somebody-else", brokerTokenSha256: BROKER_TOKEN_HASH }],
    ["a malformed token hash", { audience: "fluxrouter-composio", brokerTokenSha256: "not-a-hash" }],
    ["no binding at all", { audience: "fluxrouter-composio" }],
  ])("refuses to sign for %s", async (_label, body) => {
    const { env, statements } = claimEnv();
    const response = await issueClaim(claimRequest(body), installRow(), env as never);
    expect(response.status).toBe(400);
    expect(statements.some((statement) => statement.sql.includes("claim_issued_at"))).toBe(false);
  });

  it("stays closed until Sean opens it, and closes again at CLAIM_UNTIL", async () => {
    const closed = claimEnv({ CLAIM_MODE: "closed" });
    expect((await issueClaim(claimRequest(), installRow(), closed.env as never)).status).toBe(503);

    const ended = claimEnv({ CLAIM_UNTIL: new Date(Date.now() - 1000).toISOString() });
    const response = await issueClaim(claimRequest(), installRow(), ended.env as never);
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ code: "claims_closed" });
  });

  it("answers 503 rather than 500 when the signing key was never deployed", async () => {
    const { env } = claimEnv({ CLAIM_SIGNING_JWK: "" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await issueClaim(claimRequest(), installRow(), env as never)).status).toBe(503);
    logged.mockRestore();
  });
});

describe("confirming a claim", () => {
  it("settles only the assertion it names", async () => {
    const row = installRow({ last_claim_jti: "11111111-1111-4111-8111-111111111111" });
    const { env, statements } = claimEnv({}, row);
    const wrong = await confirmClaim(
      new Request("https://broker.test/v1/claims/confirm", { method: "POST", body: JSON.stringify({ jti: "22222222-2222-4222-8222-222222222222" }) }),
      row,
      env as never,
    );
    expect(wrong.status).toBe(409);
    await expect(wrong.json()).resolves.toMatchObject({ code: "claim_unknown" });
    expect(statements.some((statement) => statement.sql.includes("claim_confirmed_at"))).toBe(false);

    const right = await confirmClaim(
      new Request("https://broker.test/v1/claims/confirm", { method: "POST", body: JSON.stringify({ jti: row.last_claim_jti }) }),
      row,
      env as never,
    );
    expect(right.status).toBe(200);
    await expect(right.json()).resolves.toMatchObject({ confirmed: true });
    expect(statements.some((statement) => statement.sql.includes("COALESCE(claim_confirmed_at"))).toBe(true);
  });

  it("rejects a confirmation for an install that was never issued one", async () => {
    const row = installRow();
    const { env } = claimEnv({}, row);
    const response = await confirmClaim(
      new Request("https://broker.test/v1/claims/confirm", { method: "POST", body: JSON.stringify({ jti: "33333333-3333-4333-8333-333333333333" }) }),
      row,
      env as never,
    );
    expect(response.status).toBe(409);
  });
});

describe("the migration gate", () => {
  const now = Date.UTC(2026, 8, 11, 12, 0, 0);

  it("does not retire an install just because an assertion was signed", () => {
    const { env } = claimEnv();
    // Six days after issuance, with no confirmation: leg 2 may simply have
    // failed, and this install is still the only place these apps work.
    const issued = installRow({ claim_issued_at: now - 6 * DAY_MS });
    expect(migrationGate(issued, env as never, now)).toBeNull();
  });

  it("retires an install once FluxRouter accepted it and the grace period passed", () => {
    const { env } = claimEnv();
    const justConfirmed = installRow({ claim_confirmed_at: now - 60_000 });
    expect(migrationGate(justConfirmed, env as never, now)).toBeNull();

    const settled = installRow({ claim_confirmed_at: now - 1_000_000 });
    const response = migrationGate(settled, env as never, now);
    expect(response?.status).toBe(410);
  });

  it("retires an install that redeemed at FluxRouter and never confirmed, after seven days", () => {
    const { env } = claimEnv();
    const stale = installRow({ claim_issued_at: now - 8 * DAY_MS });
    expect(migrationGate(stale, env as never, now)?.status).toBe(410);
  });

  it("serves every claimed install again with MIGRATION_GATE off", () => {
    // The FluxRouter-rollback switch. The desktop kept its Worker token for
    // exactly this, and both brokers point at the same Composio user.
    const { env } = claimEnv({ MIGRATION_GATE: "off" });
    expect(migrationGate(installRow({ claim_confirmed_at: now - 1_000_000 }), env as never, now)).toBeNull();
    expect(migrationGate(installRow({ claim_issued_at: now - 30 * DAY_MS }), env as never, now)).toBeNull();
  });

  it("retires everyone at the cut-off, whatever the gate says", async () => {
    const { env } = claimEnv({ MIGRATION_GATE: "off", LEGACY_BROKER_UNTIL: new Date(now - 1000).toISOString() });
    const response = migrationGate(installRow(), env as never, now);
    expect(response?.status).toBe(410);
    await expect(response?.json()).resolves.toMatchObject({ code: "legacy_broker_retired" });
  });

  it("treats an unparseable cut-off as no cut-off rather than as now", () => {
    // A typo in a deploy var must not retire the whole fleet.
    const { env } = claimEnv({ LEGACY_BROKER_UNTIL: "next tuesday" });
    expect(migrationGate(installRow(), env as never, now)).toBeNull();
    expect(configuredInstant("next tuesday")).toBeNull();
    expect(configuredInstant("")).toBeNull();
    expect(configuredInstant("2026-12-15T00:00:00Z")).toBe(Date.UTC(2026, 11, 15));
  });
});

describe("the gate's place in the route table", () => {
  function routeEnv(row: InstallationRow, overrides: Record<string, unknown> = {}) {
    const { env, ctx } = claimEnv(overrides, row);
    return { env, ctx };
  }
  const authorized = { authorization: `Bearer ${"a".repeat(64)}` };

  it("keeps identity and both claim legs answering after an install has moved", async () => {
    const row = installRow({ claim_confirmed_at: Date.now() - 1_000_000, last_claim_jti: "44444444-4444-4444-8444-444444444444" });
    const { env, ctx } = routeEnv(row);

    const me = await route(new Request("https://broker.test/v1/me", { headers: authorized }), env as never, ctx as never);
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toEqual({ installationId: "install-1", claimIssued: false, claimConfirmed: true });

    const reissue = await route(new Request("https://broker.test/v1/claims", { method: "POST", headers: authorized, body: JSON.stringify({ audience: "fluxrouter-composio", brokerTokenSha256: BROKER_TOKEN_HASH }) }), env as never, ctx as never);
    expect(reissue.status).toBe(200);

    const confirm = await route(new Request("https://broker.test/v1/claims/confirm", { method: "POST", headers: authorized, body: JSON.stringify({ jti: row.last_claim_jti }) }), env as never, ctx as never);
    expect(confirm.status).toBe(200);
  });

  it("answers a moved install's data calls with 410, never 401", async () => {
    // A 401 makes an old desktop delete its token, and with it the identity
    // the claim and every rollback depend on.
    const row = installRow({ claim_confirmed_at: Date.now() - 1_000_000 });
    const { env, ctx } = routeEnv(row);
    for (const request of [
      new Request("https://broker.test/v1/mcp", { method: "POST", headers: authorized, body: "{}" }),
      new Request("https://broker.test/v1/catalog", { headers: authorized }),
      new Request("https://broker.test/v1/connectors/connected", { headers: authorized }),
      new Request("https://broker.test/v1/connectors?services=gmail", { headers: authorized }),
    ]) {
      const response = await route(request, env as never, ctx as never);
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toMatchObject({ code: "migrated_to_flux" });
    }
  });

  it("still answers claims after the data cut-off", async () => {
    const row = installRow({ last_claim_jti: "55555555-5555-4555-8555-555555555555" });
    const { env, ctx } = routeEnv(row, { LEGACY_BROKER_UNTIL: new Date(Date.now() - 1000).toISOString() });
    const data = await route(new Request("https://broker.test/v1/catalog", { headers: authorized }), env as never, ctx as never);
    expect(data.status).toBe(410);
    await expect(data.json()).resolves.toMatchObject({ code: "legacy_broker_retired" });

    const claim = await route(new Request("https://broker.test/v1/claims", { method: "POST", headers: authorized, body: JSON.stringify({ audience: "fluxrouter-composio", brokerTokenSha256: BROKER_TOKEN_HASH }) }), env as never, ctx as never);
    expect(claim.status).toBe(200);
    const confirm = await route(new Request("https://broker.test/v1/claims/confirm", { method: "POST", headers: authorized, body: JSON.stringify({ jti: row.last_claim_jti }) }), env as never, ctx as never);
    expect(confirm.status).toBe(200);
  });
});

describe("the daily call fuse counts executions, not requests", () => {
  it("ignores every MCP message that Composio does not bill", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(billableCallCount(encode({ jsonrpc: "2.0", id: 1, method: "initialize" }))).toBe(0);
    expect(billableCallCount(encode({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).toBe(0);
    expect(billableCallCount(encode({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBe(0);
    expect(billableCallCount(encode({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "GMAIL_SEND_EMAIL" } }))).toBe(1);
    expect(billableCallCount(encode([
      { jsonrpc: "2.0", id: 4, method: "tools/call" },
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      { jsonrpc: "2.0", id: 6, method: "tools/call" },
    ]))).toBe(2);
    // A body we cannot read counts as one: this is a fuse, and under-counting
    // is the direction that lets a runaway install through.
    expect(billableCallCount(new TextEncoder().encode("not json"))).toBe(1);
  });
});

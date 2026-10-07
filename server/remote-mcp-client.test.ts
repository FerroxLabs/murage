// SPDX-License-Identifier: AGPL-3.0-or-later
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  SseReaderError,
  classifyUnauthorized,
  createSseReader,
  headerHintFrom,
  isSameOriginEndpoint,
  nextBefore,
  parseRpcResponse,
  parseWwwAuthenticate,
  probeRemoteMcp,
  reasonForGuardedError,
  redactUpstreamText,
  remoteFailureSentence,
  safeResourceMetadataUrl,
} from "./remote-mcp-client.ts";
import { COMFY_VERBATIM_401, startFakeRemoteMcp, type FakeRemoteMcp } from "./testing/fake-remote-mcp.ts";

let fake: FakeRemoteMcp | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});
const local = { confirmed: "this-computer" as const };

describe("parseWwwAuthenticate", () => {
  it("reads the ComfyUI challenge verbatim", () => {
    expect(parseWwwAuthenticate(COMFY_VERBATIM_401.headers["www-authenticate"])).toEqual({
      scheme: "bearer",
      params: {
        realm: "comfy-cloud-mcp",
        resource_metadata: "https://cloud.comfy.org/mcp/.well-known/oauth-protected-resource",
        scope: "comfy-mcp:tools:call",
      },
    });
  });
  it("handles bare values, escaped quotes, case, arrays, and junk", () => {
    expect(parseWwwAuthenticate('Bearer error=insufficient_scope, scope="a b"')).toEqual({ scheme: "bearer", params: { error: "insufficient_scope", scope: "a b" } });
    expect(parseWwwAuthenticate('Bearer realm="a \\"b\\""')?.params.realm).toBe('a "b"');
    expect(parseWwwAuthenticate(['BEARER x="1"', "Basic"])).toEqual({ scheme: "bearer", params: { x: "1" } });
    expect(parseWwwAuthenticate(undefined)).toBeNull();
    expect(parseWwwAuthenticate("")).toBeNull();
    expect(parseWwwAuthenticate("!!!")).toBeNull();
    expect(parseWwwAuthenticate('Bearer __proto__="x"')?.params).toEqual({});
    expect(parseWwwAuthenticate("Bearer " + "a=1,".repeat(5000))).not.toBeNull();
  });
});

describe("safeResourceMetadataUrl and headerHintFrom", () => {
  it("keeps only a plain http(s) link", () => {
    expect(safeResourceMetadataUrl("https://cloud.comfy.org/mcp/.well-known/oauth-protected-resource")).toBe("https://cloud.comfy.org/mcp/.well-known/oauth-protected-resource");
    for (const bad of ["javascript:alert(1)", "ftp://x/y", "https://u:p@x.example/y", "nonsense", ""]) expect([bad, safeResourceMetadataUrl(bad)]).toEqual([bad, undefined]);
    expect(safeResourceMetadataUrl(undefined)).toBeUndefined();
  });
  it("x-api-key anywhere in the words wins, otherwise authorization", () => {
    expect(headerHintFrom("Provide an X-API-Key header")).toBe("x-api-key");
    expect(headerHintFrom(undefined, 'Bearer realm="x-api-key"')).toBe("x-api-key");
    expect(headerHintFrom("no key mention", undefined)).toBe("authorization");
  });
});

describe("classifyUnauthorized (spec 3.5 steps 4 and 5)", () => {
  it("the ComfyUI 401 verbatim: needs-sign-in with an API key alternative and headerHint x-api-key", () => {
    expect(classifyUnauthorized({ status: 401, wwwAuthenticate: COMFY_VERBATIM_401.headers["www-authenticate"], body: COMFY_VERBATIM_401.body, sent: "nothing" })).toEqual({
      reason: "needs-sign-in",
      resourceMetadataUrl: "https://cloud.comfy.org/mcp/.well-known/oauth-protected-resource",
      scope: "comfy-mcp:tools:call",
      apiKey: { headerHint: "x-api-key" },
    });
  });
  it("a challenge with no key words is sign-in only; none at all is needs-key", () => {
    expect(classifyUnauthorized({ status: 401, wwwAuthenticate: 'Bearer resource_metadata="https://a.example/prm"', sent: "nothing" })).toEqual({
      reason: "needs-sign-in", resourceMetadataUrl: "https://a.example/prm",
    });
    expect(classifyUnauthorized({ status: 401, sent: "nothing", prmExists: true })).toEqual({ reason: "needs-sign-in" });
    expect(classifyUnauthorized({ status: 401, sent: "nothing" })).toEqual({ reason: "needs-key", apiKey: { headerHint: "authorization" } });
    expect(classifyUnauthorized({ status: 401, body: "send X-API-Key", sent: "nothing" })).toEqual({ reason: "needs-key", apiKey: { headerHint: "x-api-key" } });
  });
  it("a rejected credential is key-rejected or sign-in-ended", () => {
    expect(classifyUnauthorized({ status: 401, sent: "key" })).toEqual({ reason: "key-rejected" });
    expect(classifyUnauthorized({ status: 403, sent: "key" })).toEqual({ reason: "key-rejected" });
    expect(classifyUnauthorized({ status: 401, sent: "bearer" })).toEqual({ reason: "sign-in-ended" });
  });
  it("403 insufficient_scope is needs-more-access with the scope list, even with a credential", () => {
    expect(classifyUnauthorized({ status: 403, wwwAuthenticate: 'Bearer error="insufficient_scope", scope="tools:write tools:admin"', sent: "bearer" })).toEqual({
      reason: "needs-more-access", scopes: ["tools:write", "tools:admin"],
    });
  });
  it("a hostile resource_metadata never survives", () => {
    const result = classifyUnauthorized({ status: 401, wwwAuthenticate: 'Bearer resource_metadata="javascript:alert(1)"', sent: "nothing" });
    expect(result).toEqual({ reason: "needs-key", apiKey: { headerHint: "authorization" } });
  });
});

describe("reasonForGuardedError", () => {
  it.each([
    ["not-found", "not-found"], ["unresolved-address", "not-found"], ["dns-timeout", "no-answer"], ["timeout", "no-answer"],
    ["unreachable", "unreachable"], ["https-required", "https-required"], ["local-confirm", "local-confirm"],
    ["address-changed", "address-changed"], ["refused-address", "blocked-address"], ["address-mismatch", "blocked-address"],
    ["aborted", "cancelled"], ["body-too-large", "wrong-address"], ["invalid-address", "wrong-address"], ["credentials-in-address", "wrong-address"],
    ["invalid-header", "wrong-address"], ["something-new", "wrong-address"],
  ])("%s gives %s", (code, reason) => {
    expect(reasonForGuardedError(code)).toBe(reason);
  });
});

describe("isSameOriginEndpoint and redactUpstreamText", () => {
  it("accepts relative and same-origin endpoints only", () => {
    const server = "https://mcp.example.com/sse";
    expect(isSameOriginEndpoint(server, "/messages?sessionId=1")).toBe(true);
    expect(isSameOriginEndpoint(server, "https://mcp.example.com/messages")).toBe(true);
    expect(isSameOriginEndpoint(server, "https://mcp.example.com:8443/messages")).toBe(false);
    expect(isSameOriginEndpoint(server, "http://mcp.example.com/messages")).toBe(false);
    expect(isSameOriginEndpoint(server, "https://evil.example/messages")).toBe(false);
    expect(isSameOriginEndpoint(server, "https://mcp.example.com.evil.test/m")).toBe(false);
    expect(isSameOriginEndpoint(server, "//evil.example/m")).toBe(false);
    expect(isSameOriginEndpoint("nonsense", "/m")).toBe(false);
  });
  it("replaces every configured secret and leaves short words alone", () => {
    expect(redactUpstreamText("key=abc12345 and abc12345 again, id=1", ["abc12345", "1", ""])).toBe("key=[redacted] and [redacted] again, id=1");
  });
});

describe("remoteFailureSentence copy", () => {
  it("has a sentence for every reason and obeys the copy rules", () => {
    const reasons = [
      "needs-sign-in", "needs-key", "key-rejected", "sign-in-ended", "needs-more-access", "not-found", "unreachable", "wrong-address", "moved",
      "https-required", "local-confirm", "address-changed", "blocked-address", "server-error", "no-answer", "session-gone", "cancelled",
    ] as const;
    for (const reason of reasons) {
      for (const needs of ["this-computer", "local-network"] as const) {
        const sentence = remoteFailureSentence(reason, { host: "cloud.comfy.org", suggestUrl: "https://new.example/s/abcdefghijklmnopqrstuvwx/mcp", needs });
        expect(sentence.length).toBeGreaterThan(10);
        expect(sentence).not.toMatch(/[–—]/);
        expect(sentence).not.toMatch(/\b(safe|safely|safety|unsafe|composio|price|pricing)\b/i);
        expect(sentence).not.toContain("abcdefghijklmnopqrstuvwx");
      }
    }
    expect(remoteFailureSentence("needs-sign-in", { host: "cloud.comfy.org" })).toBe("This server needs you to sign in to cloud.comfy.org.");
    expect(remoteFailureSentence("not-found", { host: "cloud.comfy.org" })).toBe("Murage could not find cloud.comfy.org. Check the link and your internet connection.");
  });
});

describe("createSseReader (review L7: idle timeout and per-event cap)", () => {
  const read = async (chunks: string[], options = { idleMs: 500, maxEventBytes: 1024 }) => {
    const events: Array<{ event: string; data: string }> = [];
    let failure: unknown;
    try {
      for await (const event of createSseReader(Readable.from(chunks), options)) events.push(event);
    } catch (error) {
      failure = error;
    }
    return { events, failure };
  };
  it("parses events across chunk boundaries, CRLF, comments and multi-line data", async () => {
    const { events, failure } = await read(["event: endpoint\nda", "ta: /m?id=1\n\n: ping\n\ndata: a\r\ndata: b\r\n\r\nevent: x\n\n"]);
    expect(events).toEqual([{ event: "endpoint", data: "/m?id=1" }, { event: "message", data: "a\nb" }]);
    expect(failure).toMatchObject({ code: "closed" });
  });
  it("fails event-too-large when one event passes the cap, even in small pieces", async () => {
    const { failure } = await read(["data: " + "x".repeat(600) + "\n", "data: " + "y".repeat(600) + "\n\n"]);
    expect(failure).toBeInstanceOf(SseReaderError);
    expect(failure).toMatchObject({ code: "event-too-large" });
  });
  it("fails event-too-large on a line that never ends", async () => {
    const { failure } = await read(["data: " + "z".repeat(5000)]);
    expect(failure).toMatchObject({ code: "event-too-large" });
  });
  it("fails idle-timeout when the stream goes quiet", async () => {
    const slow = (async function* () { yield "data: one\n\n"; await new Promise((resolve) => setTimeout(resolve, 400)); yield "data: two\n\n"; })();
    const events: string[] = [];
    let failure: unknown;
    try { for await (const event of createSseReader(slow, { idleMs: 80, maxEventBytes: 1024 })) events.push(event.data); } catch (error) { failure = error; }
    expect(events).toEqual(["one"]);
    expect(failure).toMatchObject({ code: "idle-timeout" });
  });
  it("two events that are each under the cap are fine together", async () => {
    const { events } = await read(["data: " + "a".repeat(700) + "\n\n", "data: " + "b".repeat(700) + "\n\n"]);
    expect(events).toHaveLength(2);
  });
});

describe("parseRpcResponse", () => {
  it("takes the frame for this id from JSON or SSE, and nothing else", () => {
    expect(parseRpcResponse('{"jsonrpc":"2.0","id":2,"result":{}}', 2)).toMatchObject({ id: 2 });
    expect(parseRpcResponse('{"jsonrpc":"2.0","id":3,"result":{}}', 2)).toBeNull();
    expect(parseRpcResponse('event: message\ndata: {"id":1}\n\ndata: {"id":2,"result":{}}\n\n', 2)).toMatchObject({ id: 2 });
    expect(parseRpcResponse('data: {"id":9}\n\n', 2)).toBeNull();
    expect(parseRpcResponse("", 1)).toBeNull();
    expect(parseRpcResponse("{not json", 1)).toBeNull();
  });
});

describe("probeRemoteMcp against the fake server", () => {
  it("streamable HTTP with no auth lists the tools and reports the transport", async () => {
    fake = await startFakeRemoteMcp({ auth: "none" });
    const result = await probeRemoteMcp({ url: fake.mcpUrl, ...local });
    expect(result).toEqual({ ok: true, transport: "http", tools: [{ name: "echo", description: "Echo the text back" }, { name: "sum", description: "Add two numbers" }] });
  });
  it("reads an SSE-framed answer", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", respondWith: "sse" });
    expect(await probeRemoteMcp({ url: fake.mcpUrl, ...local })).toMatchObject({ ok: true, transport: "http" });
  });
  it("an API key goes in the header it was given and nowhere else", async () => {
    fake = await startFakeRemoteMcp({ auth: "api-key", apiKey: "k-123456" });
    const result = await probeRemoteMcp({ url: fake.mcpUrl, headers: { "x-api-key": "k-123456" }, ...local });
    expect(result).toMatchObject({ ok: true });
    for (const request of fake.requests) expect(request.headers["x-api-key"]).toBe("k-123456");
    expect(fake.requests.some((request) => request.headers.authorization !== undefined)).toBe(false);
  });
  it("a bearer token works, and a wrong one is sign-in-ended", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer" });
    expect(await probeRemoteMcp({ url: fake.mcpUrl, bearer: fake.mintAccessToken(), ...local })).toMatchObject({ ok: true });
    const wrong = await probeRemoteMcp({ url: fake.mcpUrl, bearer: "at_wrong_value_123", ...local });
    expect(wrong).toMatchObject({ ok: false, reason: "sign-in-ended", error: expect.stringContaining("Sign in again") });
  });
  it("ComfyUI style 401 (verbatim headers and body): needs-sign-in, the key alternative, headerHint x-api-key", async () => {
    fake = await startFakeRemoteMcp({ auth: "both", unauthorized: "comfy-verbatim" });
    const result = await probeRemoteMcp({ url: fake.mcpUrl, ...local });
    expect(result).toMatchObject({
      ok: false, reason: "needs-sign-in", apiKey: { headerHint: "x-api-key" },
      signIn: { host: "127.0.0.1", resourceMetadataUrl: "https://cloud.comfy.org/mcp/.well-known/oauth-protected-resource", scopeHint: "comfy-mcp:tools:call" },
    });
    expect((result as { error: string }).error).toBe("This server needs you to sign in to 127.0.0.1.");
  });
  it("finds the sign-in route by protected-resource discovery when the 401 names none", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", unauthorized: "plain", prm: true });
    expect(await probeRemoteMcp({ url: fake.mcpUrl, ...local })).toMatchObject({ ok: false, reason: "needs-sign-in" });
    fake.options.prm = false;
    expect(await probeRemoteMcp({ url: fake.mcpUrl, ...local })).toMatchObject({ ok: false, reason: "needs-key", apiKey: { headerHint: "authorization" } });
    fake.options.unauthorized = "api-key-only";
    expect(await probeRemoteMcp({ url: fake.mcpUrl, ...local })).toMatchObject({ ok: false, reason: "needs-key", apiKey: { headerHint: "x-api-key" } });
  });
  it("a rejected key is key-rejected", async () => {
    fake = await startFakeRemoteMcp({ auth: "api-key", apiKey: "right-key-1" });
    expect(await probeRemoteMcp({ url: fake.mcpUrl, headers: { "x-api-key": "wrong-key-1" }, ...local })).toMatchObject({ ok: false, reason: "key-rejected" });
  });

  it("a legacy SSE server works, and the working transport is reported", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse" });
    const result = await probeRemoteMcp({ url: fake.mcpUrl, ...local });
    expect(result).toMatchObject({ ok: true, transport: "sse", tools: [{ name: "echo" }, { name: "sum" }] });
    expect(await probeRemoteMcp({ url: fake.mcpUrl, transport: "sse", ...local })).toMatchObject({ ok: true, transport: "sse" });
    // A stored transport of "http" never falls back.
    expect(await probeRemoteMcp({ url: fake.mcpUrl, transport: "http", ...local })).toMatchObject({ ok: false, reason: "wrong-address" });
  });
  it("legacy SSE with bearer auth sends the token on the stream and on every POST", async () => {
    fake = await startFakeRemoteMcp({ auth: "bearer", transport: "sse" });
    const token = fake.mintAccessToken();
    expect(await probeRemoteMcp({ url: fake.mcpUrl, bearer: token, ...local })).toMatchObject({ ok: true, transport: "sse" });
    for (const request of fake.requests.filter((entry) => entry.path === "/mcp" || entry.path === "/messages")) {
      if (request.method === "POST" && request.path === "/mcp") continue; // the failed streamable attempt carried it too
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
    }
  });
  it("a cross-origin endpoint event is refused and nothing is sent there", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse", sseEndpoint: "cross-origin" });
    expect(await probeRemoteMcp({ url: fake.mcpUrl, ...local })).toMatchObject({ ok: false, reason: "wrong-address" });
    expect(fake.requests.filter((entry) => entry.path === "/messages")).toHaveLength(0);
  });
  it("a stream that never announces an endpoint ends at the idle limit as no-answer", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", transport: "sse", sseSilent: true });
    expect(await probeRemoteMcp({ url: fake.mcpUrl, idleMs: 150, ...local })).toMatchObject({ ok: false, reason: "no-answer" });
  });

  it("every reason in spec 3.6 that a link can give", async () => {
    // wrong-address: nothing at this path on either transport
    fake = await startFakeRemoteMcp({ auth: "none" });
    expect(await probeRemoteMcp({ url: `${fake.origin}/nope`, ...local })).toMatchObject({ ok: false, reason: "wrong-address" });
    // moved: one hop, re-checked
    fake.options.mcpMovedTo = "https://new.example/mcp";
    expect(await probeRemoteMcp({ url: fake.mcpUrl, headers: { "x-api-key": "k-12345" }, ...local })).toMatchObject({ ok: false, reason: "moved", suggestUrl: "https://new.example/mcp" });
    fake.options.mcpMovedTo = "ftp://new.example/mcp";
    expect(await probeRemoteMcp({ url: fake.mcpUrl, ...local })).toMatchObject({ ok: false, reason: "wrong-address" });
    fake.options.mcpMovedTo = undefined;
    // server-error
    fake.options.mcpFailStatus = 503;
    expect(await probeRemoteMcp({ url: fake.mcpUrl, ...local })).toMatchObject({ ok: false, reason: "server-error" });
    fake.options.mcpFailStatus = 418;
    expect(await probeRemoteMcp({ url: fake.mcpUrl, ...local })).toMatchObject({ ok: false, reason: "wrong-address" });
    fake.options.mcpFailStatus = undefined;
    // no-answer: 20 s total, shortened here
    fake.options.initializeDelayMs = 2_000;
    expect(await probeRemoteMcp({ url: fake.mcpUrl, totalMs: 250, ...local })).toMatchObject({ ok: false, reason: "no-answer", error: "The server did not answer in time. Try again in a moment." });
    fake.options.initializeDelayMs = 0;
    // local-confirm and address-changed, both before anything is sent
    const before = fake.requests.length;
    expect(await probeRemoteMcp({ url: fake.mcpUrl, mode: "inspect", confirmed: null })).toMatchObject({ ok: false, reason: "local-confirm", needs: "this-computer" });
    expect(await probeRemoteMcp({ url: fake.mcpUrl, confirmed: "local-network" })).toMatchObject({ ok: false, reason: "address-changed" });
    expect(fake.requests.length).toBe(before);
  });

  it("not-found, unreachable, https-required, blocked-address and cancelled, all without contacting anything", async () => {
    expect(await probeRemoteMcp({ url: "https://nowhere.example/mcp", resolver: async () => { throw new Error("ENOTFOUND"); } })).toMatchObject({ ok: false, reason: "not-found", error: "Murage could not find nowhere.example. Check the link and your internet connection." });
    expect(await probeRemoteMcp({ url: "http://pub.example/mcp", resolver: async () => [{ address: "93.184.216.34" }] })).toMatchObject({ ok: false, reason: "https-required" });
    for (const url of ["http://169.254.169.254/latest", "https://[fe80::1]/mcp", "http://metadata.google.internal/"]) {
      expect([url, (await probeRemoteMcp({ url, confirmed: "local-network" })).ok === false && (await probeRemoteMcp({ url, confirmed: "local-network" }) as { reason: string }).reason]).toEqual([url, "blocked-address"]);
    }
    expect(await probeRemoteMcp({ url: "ftp://x.example/mcp" })).toMatchObject({ ok: false, reason: "wrong-address" });
    expect(await probeRemoteMcp({ url: "nonsense" })).toMatchObject({ ok: false, reason: "wrong-address" });
    const controller = new AbortController();
    controller.abort();
    expect(await probeRemoteMcp({ url: "https://x.example/mcp", signal: controller.signal, resolver: async () => [{ address: "93.184.216.34" }] })).toMatchObject({ ok: false, reason: "cancelled" });
    // unreachable: a port nothing listens on
    const dead = await startFakeRemoteMcp({ auth: "none" });
    const deadUrl = dead.mcpUrl;
    await dead.close();
    expect(await probeRemoteMcp({ url: deadUrl, ...local })).toMatchObject({ ok: false, reason: "unreachable", error: "127.0.0.1 did not accept the connection. Check the link, or try again in a moment." });
  });

  it("no header or body text from upstream reaches the result, and configured secrets are redacted from tool metadata", async () => {
    fake = await startFakeRemoteMcp({ auth: "api-key", apiKey: "topsecretkey9", mcpFailStatus: 500 });
    const failed = await probeRemoteMcp({ url: fake.mcpUrl, headers: { "x-api-key": "topsecretkey9" }, ...local });
    expect(JSON.stringify(failed)).not.toMatch(/UPSTREAM-BODY-TEXT|UPSTREAM-HEADER-TEXT/);
    fake.options.mcpFailStatus = undefined;
    fake.options.toolDescription = "your key is topsecretkey9 (keep it)";
    const ok = await probeRemoteMcp({ url: fake.mcpUrl, headers: { "x-api-key": "topsecretkey9" }, ...local });
    expect(ok).toMatchObject({ ok: true });
    expect(JSON.stringify(ok)).not.toContain("topsecretkey9");
    expect(JSON.stringify(ok)).toContain("[redacted]");
  });

  it("lists at most 100 tools", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", toolCount: 250 });
    const result = await probeRemoteMcp({ url: fake.mcpUrl, ...local });
    expect(result.ok && result.tools).toHaveLength(100);
  });

  it("an oversize response is wrong-address, not a memory problem", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", oversizeMcpBytes: 21 * 1024 * 1024 });
    expect(await probeRemoteMcp({ url: fake.mcpUrl, totalMs: 15_000, ...local })).toMatchObject({ ok: false, reason: "wrong-address" });
  }, 20_000);
});

describe("M3: a redirect never hands the secret link to the renderer", () => {
  it("suggestUrl is the masked form, with a flag when the address holds a secret", async () => {
    const token = "AbCdEf0123456789XyZabcdef";
    fake = await startFakeRemoteMcp({ auth: "none", mcpMovedTo: `/s/${token}/mcp/` });
    const result = await probeRemoteMcp({ url: fake.mcpUrl, ...local });
    const text = JSON.stringify(result);
    expect(result).toMatchObject({ ok: false, reason: "moved", suggestHoldsSecret: true });
    expect(text).not.toContain(token);
    expect((result as { suggestUrl: string }).suggestUrl).toContain("\u2022\u2022\u2022");
    expect((result as { error: string }).error).not.toContain(token);
  });
  it("an address with no secret is offered as itself, flagged as holding none", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", mcpMovedTo: "https://new.example/mcp" });
    expect(await probeRemoteMcp({ url: fake.mcpUrl, ...local })).toMatchObject({ reason: "moved", suggestUrl: "https://new.example/mcp", suggestHoldsSecret: false });
  });
  it("a query secret in the Location is dropped from the suggestion", async () => {
    fake = await startFakeRemoteMcp({ auth: "none", mcpMovedTo: "https://new.example/mcp?key=QSECRET" });
    const result = await probeRemoteMcp({ url: fake.mcpUrl, ...local });
    expect(JSON.stringify(result)).not.toContain("QSECRET");
    expect(result).toMatchObject({ suggestUrl: "https://new.example/mcp", suggestHoldsSecret: true });
  });
});

describe("M4: a legacy SSE probe honours its total limit and its caller's abort", () => {
  const servers: http.Server[] = [];
  const timers: NodeJS.Timeout[] = [];
  afterEach(async () => {
    for (const timer of timers.splice(0)) clearInterval(timer);
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  });
  async function busyLegacyServer(): Promise<string> {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/") { res.writeHead(405); res.end(); return; }
        if (req.method === "GET") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("event: endpoint\ndata: /msg\n\n");
          // comment lines reset the reader's idle timer, so it never goes idle
          timers.push(setInterval(() => res.write(": keep\n\n"), 50));
          return;
        }
        res.writeHead(202); res.end(); // accepts the POST and never answers on the stream
      });
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  it("REV2-2: ends at totalMs as no-answer although the stream stays busy", async () => {
    const url = await busyLegacyServer();
    const started = Date.now();
    const result = await probeRemoteMcp({ url, confirmed: "this-computer", totalMs: 300, idleMs: 5_000 });
    expect(result).toMatchObject({ ok: false, reason: "no-answer" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("REV2-2: ends at once when the caller aborts", async () => {
    const url = await busyLegacyServer();
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    const result = await probeRemoteMcp({ url, confirmed: "this-computer", totalMs: 20_000, idleMs: 5_000, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, reason: "cancelled" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("nextBefore rejects at the deadline, on abort, and when already aborted, and otherwise passes the item through", async () => {
    const never = { next: () => new Promise<IteratorResult<number>>(() => undefined) };
    await expect(nextBefore(never, Date.now() + 30, undefined, () => new Error("deadline"), () => new Error("abort"))).rejects.toThrow("deadline");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(nextBefore(never, Date.now() + 5_000, controller.signal, () => new Error("deadline"), () => new Error("abort"))).rejects.toThrow("abort");
    await expect(nextBefore(never, Date.now() + 5_000, controller.signal, () => new Error("deadline"), () => new Error("abort"))).rejects.toThrow("abort");
    const ready = { next: async (): Promise<IteratorResult<number>> => ({ done: false, value: 7 }) };
    expect(await nextBefore(ready, Date.now() + 1_000, undefined, () => new Error("d"), () => new Error("a"))).toEqual({ done: false, value: 7 });
  });
});

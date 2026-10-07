// SPDX-License-Identifier: AGPL-3.0-or-later
// The guarded client against a real local server. The server only ever listens
// on loopback, so every test confirms "this-computer" (or proves the refusal
// that happens without it). Names in these tests resolve through an injected
// resolver; nothing touches real DNS or the real network.
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GuardedHttpError, guardedRequest as publicGuardedRequest, type GuardedRequestOptions } from "./guarded-http.mjs";
import { withSeams } from "./guarded-http.testing.mjs";

/** The tests serve plain http from loopback, so they reach the client through
 * the test-only seams (review L2); the public options no longer carry them. */
type TestOptions = GuardedRequestOptions & {
  transportForTests?: () => typeof http;
  testHooks?: { tamperAddress?: (address: string) => string };
};
function guardedRequest(options: TestOptions & { responseMode: "stream" }): ReturnType<typeof publicGuardedRequest>;
function guardedRequest(options: TestOptions): ReturnType<typeof publicGuardedRequest>;
function guardedRequest(options: TestOptions) {
  const { transportForTests, testHooks, ...rest } = options;
  return publicGuardedRequest(withSeams(rest, { transportFor: transportForTests, tamperAddress: testHooks?.tamperAddress }));
}

type Seen = { method: string; url: string; host: string | undefined; headers: http.IncomingHttpHeaders; body: string };

let server: http.Server;
let port = 0;
let connections = 0;
let seen: Seen[] = [];
let handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

beforeEach(async () => {
  connections = 0;
  seen = [];
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  };
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method ?? "", url: req.url ?? "", host: req.headers.host, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  server.on("connection", () => { connections += 1; });
  // 0.0.0.0 so the address-mismatch test can be reached on 127.0.0.2 (Linux).
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const local = (extra: Record<string, unknown> = {}) => ({
  confirmed: "this-computer" as const,
  transportForTests: () => http,
  ...extra,
});
const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof GuardedHttpError ? error.code : `not-guarded:${String(error)}`;
  }
  return "no-error";
};

describe("a confirmed loopback server", () => {
  it("GETs and POSTs, returns status, headers, body and the address it reached", async () => {
    handler = (_req, res, body) => {
      res.writeHead(201, { "x-echo": "1" });
      res.end(`got:${body}`);
    };
    const response = await guardedRequest({
      url: `http://127.0.0.1:${port}/mcp?x=1`, method: "POST", body: "hello",
      headers: { "content-type": "text/plain", "x-api-key": "k" }, ...local(),
    });
    expect(response.status).toBe(201);
    expect(response.headers["x-echo"]).toBe("1");
    expect(response.body.toString()).toBe("got:hello");
    expect(response.remoteAddress).toBe("127.0.0.1");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/mcp?x=1", body: "hello" });
    expect(seen[0]!.headers["x-api-key"]).toBe("k");
    expect(seen[0]!.headers["content-length"]).toBe("5");
  });

  it("does not let the caller set Host, Content-Length, Connection or Transfer-Encoding", async () => {
    await guardedRequest({
      url: `http://127.0.0.1:${port}/`, method: "POST", body: "abc",
      headers: { Host: "evil.example", "Content-Length": "999", Connection: "upgrade", "Transfer-Encoding": "chunked" }, ...local(),
    });
    expect(seen[0]!.host).toBe(`127.0.0.1:${port}`);
    expect(seen[0]!.headers["content-length"]).toBe("3");
    expect(seen[0]!.headers["transfer-encoding"]).toBeUndefined();
  });

  it("resolves a name exactly once per request and connects to the judged address", async () => {
    const calls: string[] = [];
    const resolver = async (host: string) => { calls.push(host); return [{ address: "127.0.0.1", family: 4 }]; };
    const response = await guardedRequest({ url: `http://mcp.example.test:${port}/x`, resolver, ...local() });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["mcp.example.test"]);
    expect(seen[0]!.host).toBe(`mcp.example.test:${port}`);
    await guardedRequest({ url: `http://127.0.0.1:${port}/x`, resolver, ...local() });
    expect(calls).toHaveLength(1); // a literal address never asks DNS
  });
});

describe("refusals send nothing", () => {
  it("an unconfirmed loopback address: local-confirm when inspecting, address-changed when requesting", async () => {
    const inspected = guardedRequest({ url: `http://127.0.0.1:${port}/`, mode: "inspect", transportForTests: () => http });
    await expect(inspected).rejects.toMatchObject({ code: "local-confirm", needs: "this-computer" });
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, transportForTests: () => http }))).toBe("address-changed");
    expect(connections).toBe(0);
  });

  it("http to a public address is https-required and nothing is resolved twice or connected", async () => {
    let resolved = 0;
    const resolver = async () => { resolved += 1; return [{ address: "93.184.216.34" }]; };
    expect(await codeOf(guardedRequest({ url: "http://example.test/mcp", resolver }))).toBe("https-required");
    expect(resolved).toBe(1);
  });

  it("literal link-local, metadata, unspecified and multicast addresses are refused without DNS", async () => {
    let resolved = 0;
    const resolver = async () => { resolved += 1; return []; };
    for (const url of ["http://169.254.169.254/latest", "https://169.254.169.254/", "http://[fe80::1]/", "http://0.0.0.0:1/", "http://100.100.100.200/", "http://[fd00:ec2::254]/", "http://224.0.0.1/"]) {
      for (const confirmed of [null, "this-computer", "local-network"] as const) {
        expect([url, await codeOf(guardedRequest({ url, resolver, confirmed, transportForTests: () => http }))]).toEqual([url, "refused-address"]);
      }
    }
    expect(resolved).toBe(0);
  });

  it("a name refused by its spelling never asks DNS", async () => {
    let resolved = 0;
    const resolver = async () => { resolved += 1; return [{ address: "93.184.216.34" }]; };
    for (const url of ["http://metadata.google.internal/", "https://METADATA.GOOGLE.INTERNAL./x", "http://instance-data/", "http://metadata/"]) {
      expect([url, await codeOf(guardedRequest({ url, resolver, ...local() }))]).toEqual([url, "refused-address"]);
    }
    expect(resolved).toBe(0);
  });

  it("one refused address anywhere in the answer refuses the request", async () => {
    const resolver = async () => [{ address: "127.0.0.1" }, { address: "169.254.169.254" }];
    expect(await codeOf(guardedRequest({ url: `http://mcp.example.test:${port}/`, resolver, ...local() }))).toBe("refused-address");
    expect(connections).toBe(0);
  });

  it("credentials in the link are refused", async () => {
    expect(await codeOf(guardedRequest({ url: `http://me:pw@127.0.0.1:${port}/`, ...local() }))).toBe("credentials-in-address");
  });

  it("a name that does not resolve is not-found, and a slow resolver is dns-timeout", async () => {
    expect(await codeOf(guardedRequest({ url: "https://nowhere.test/", resolver: async () => { throw new Error("ENOTFOUND"); } }))).toBe("not-found");
    expect(await codeOf(guardedRequest({ url: "https://slow.test/", dnsMs: 40, resolver: () => new Promise(() => undefined) }))).toBe("dns-timeout");
  });
});

describe("rebinding: the address is judged again on every request", () => {
  it("public then private is refused on the second call, and the server is reached only while the answer was in the confirmed class", async () => {
    const answers = [
      [{ address: "127.0.0.1" }],          // the confirmed class: connects
      [{ address: "169.254.169.254" }],    // metadata: refused
      [{ address: "10.0.0.5" }],           // private, but this-computer was confirmed: address-changed
      [{ address: "93.184.216.34" }],      // public: address-changed
      [{ address: "127.0.0.1" }],          // back in class: connects again
    ];
    let call = 0;
    const resolver = async () => answers[call++]!;
    const run = () => guardedRequest({ url: `http://mcp.example.test:${port}/`, resolver, ...local() });
    expect((await run()).status).toBe(200);
    expect(await codeOf(run())).toBe("refused-address");
    expect(await codeOf(run())).toBe("address-changed");
    expect(await codeOf(run())).toBe("address-changed");
    expect((await run()).status).toBe(200);
    expect(call).toBe(5);
    expect(connections).toBe(2);
  });

  it("a stored public entry whose name starts resolving to loopback or private gets no request", async () => {
    for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "100.64.0.1"]) {
      const code = await codeOf(guardedRequest({
        url: `https://mcp.example.test:${port}/`, resolver: async () => [{ address }], transportForTests: () => http,
      }));
      expect([address, code]).toEqual([address, "address-changed"]);
    }
    expect(connections).toBe(0);
  });
});

describe("a request never connects to an address it did not validate", () => {
  it("destroys the socket and sends no byte when the lookup hands back something else", async () => {
    // Linux answers on all of 127.0.0.0/8, so 127.0.0.2 reaches the test server.
    const code = await codeOf(guardedRequest({
      url: `http://mcp.example.test:${port}/`, method: "POST", body: "secret-body",
      resolver: async () => [{ address: "127.0.0.1" }],
      testHooks: { tamperAddress: () => "127.0.0.2" }, ...local(),
    }));
    expect(code).toBe("address-mismatch");
    expect(seen).toHaveLength(0);
  });

  it("the honest path passes the same check", async () => {
    const response = await guardedRequest({
      url: `http://mcp.example.test:${port}/`, resolver: async () => [{ address: "127.0.0.1" }], ...local(),
    });
    expect(response.remoteAddress).toBe("127.0.0.1");
  });
});

describe("redirects", () => {
  const chain = (hops: number, last: string) => {
    handler = (req, res) => {
      const n = Number(/\/r(\d+)$/.exec(req.url ?? "")?.[1] ?? "-1");
      if (req.url === "/start" || (n >= 0 && n < hops)) {
        res.writeHead(302, { location: n + 1 < hops || req.url === "/start" ? `/r${req.url === "/start" ? 0 : n + 1}` : last });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("final");
    };
  };

  it("metadata follows up to 3 hops", async () => {
    chain(3, "/final");
    // /start -> /r0 -> /r1 -> /r2 -> /final : that is 4 redirects, too many.
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/start`, kind: "metadata", ...local() }))).toBe("too-many-redirects");
    seen = [];
    handler = (req, res) => {
      if (req.url === "/a") { res.writeHead(302, { location: "/b" }); res.end(); return; }
      if (req.url === "/b") { res.writeHead(307, { location: "/c" }); res.end(); return; }
      if (req.url === "/c") { res.writeHead(301, { location: "/d" }); res.end(); return; }
      res.writeHead(200); res.end("done");
    };
    const response = await guardedRequest({ url: `http://127.0.0.1:${port}/a`, kind: "metadata", ...local() });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("done");
    expect(response.hops).toBe(3);
    expect(seen.map((entry) => entry.url)).toEqual(["/a", "/b", "/c", "/d"]);
  });

  it("does not carry credentials to a redirect target and follows with GET", async () => {
    handler = (req, res) => {
      if (req.url === "/a") { res.writeHead(307, { location: "/b" }); res.end(); return; }
      res.writeHead(200); res.end("b");
    };
    await guardedRequest({
      url: `http://127.0.0.1:${port}/a`, kind: "metadata", method: "POST", body: "x",
      headers: { authorization: "Bearer t", "x-api-key": "k", cookie: "c=1", accept: "application/json" }, ...local(),
    });
    expect(seen[1]).toMatchObject({ method: "GET", url: "/b", body: "" });
    expect(seen[1]!.headers.authorization).toBeUndefined();
    expect(seen[1]!.headers["x-api-key"]).toBeUndefined();
    expect(seen[1]!.headers.cookie).toBeUndefined();
    expect(seen[1]!.headers.accept).toBe("application/json");
  });

  it("a redirect to the metadata address is refused and no request is made to it", async () => {
    handler = (_req, res) => { res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }); res.end(); };
    let resolved = 0;
    const resolver = async () => { resolved += 1; return []; };
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, kind: "metadata", resolver, ...local() }))).toBe("refused-address");
    expect(resolved).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("a redirect out of the confirmed class is address-changed", async () => {
    for (const target of ["http://10.0.0.5/x", "http://93.184.216.34/x", "https://example.test/x"]) {
      seen = [];
      handler = (_req, res) => { res.writeHead(302, { location: target }); res.end(); };
      const code = await codeOf(guardedRequest({
        url: `http://127.0.0.1:${port}/`, kind: "metadata", resolver: async () => [{ address: "93.184.216.34" }], ...local(),
      }));
      expect([target, code]).toEqual([target, "address-changed"]);
      expect(seen).toHaveLength(1);
    }
  });

  it("an unconfirmed entry whose name now resolves to loopback gets no request, redirecting server or not", async () => {
    handler = (_req, res) => { res.writeHead(302, { location: "http://127.0.0.1:1/" }); res.end(); };
    // The name is judged by what it resolves to, not by how it is spelled.
    const code = await codeOf(guardedRequest({
      url: `https://example.test:${port}/`, kind: "metadata", resolver: async () => [{ address: "127.0.0.1" }], transportForTests: () => http,
    }));
    expect(code).toBe("address-changed");
    expect(seen).toHaveLength(0);
  });

  it.each(["mcp", "sse", "token", "register"] as const)("%s never follows: the 3xx comes back untouched", async (kind) => {
    handler = (_req, res) => { res.writeHead(308, { location: "https://elsewhere.example/mcp" }); res.end(); };
    const response = await guardedRequest({ url: `http://127.0.0.1:${port}/`, kind, method: "POST", body: "{}", ...local() });
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe("https://elsewhere.example/mcp");
    expect(seen).toHaveLength(1);
  });
});

describe("review F1: a redirect keeps only an allowlist of headers", () => {
  it("drops every stored secret header, under any name, when the origin changes", async () => {
    handler = (req, res) => {
      if (req.socket.localAddress === "127.0.0.1") { res.writeHead(302, { location: `http://127.0.0.2:${port}/elsewhere` }); res.end(); return; }
      res.writeHead(200); res.end("ok");
    };
    const response = await guardedRequest({
      url: `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`, kind: "metadata",
      headers: {
        "X-Goog-Api-Key": "SECRET-1", "Api-Key": "SECRET-2", "X-Auth-Token": "SECRET-3", "Private-Token": "SECRET-4", Authorization: "Bearer B",
        Accept: "application/json", "User-Agent": "murage-test", "MCP-Protocol-Version": "2025-06-18", "Accept-Language": "en",
      },
      ...local(),
    });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(2);
    const second = seen[1]!;
    expect(second.headers["x-goog-api-key"]).toBeUndefined();
    expect(second.headers["api-key"]).toBeUndefined();
    expect(second.headers["x-auth-token"]).toBeUndefined();
    expect(second.headers["private-token"]).toBeUndefined();
    expect(second.headers.authorization).toBeUndefined();
    expect(second.headers.accept).toBe("application/json");
    expect(second.headers["user-agent"]).toBe("murage-test");
    expect(second.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(second.headers["accept-language"]).toBe("en");
    expect(JSON.stringify(second.headers)).not.toMatch(/SECRET-|Bearer B/);
  });

  it("drops them on a same-origin hop too", async () => {
    handler = (req, res) => {
      if (req.url === "/a") { res.writeHead(302, { location: "/b" }); res.end(); return; }
      res.writeHead(200); res.end("ok");
    };
    await guardedRequest({ url: `http://127.0.0.1:${port}/a`, kind: "metadata", headers: { "X-Custom-Key": "SECRET-5" }, ...local() });
    expect(seen[0]!.headers["x-custom-key"]).toBe("SECRET-5");
    expect(seen[1]!.headers["x-custom-key"]).toBeUndefined();
  });
});

describe("review L2: the test seams are not reachable from the public options", () => {
  it("an https link is never sent as plain http because an option asked for it", async () => {
    const options = {
      url: `https://mcp.example.test:${port}/`, resolver: async () => [{ address: "127.0.0.1" }], confirmed: "this-computer" as const,
      headers: { authorization: "Bearer T" },
      transportForTests: () => http, testHooks: { tamperAddress: () => "127.0.0.2" },
    };
    const code = await codeOf(publicGuardedRequest(options as unknown as GuardedRequestOptions));
    expect(code).not.toBe("no-error");
    expect(seen).toHaveLength(0);
  });
});

describe("review L5 and L6: headers", () => {
  it("drops hop-by-hop and request-shaping headers instead of sending them", async () => {
    await guardedRequest({
      url: `http://127.0.0.1:${port}/`, method: "POST", body: "x",
      headers: { Expect: "100-continue", Upgrade: "websocket", TE: "trailers", Trailer: "X", "Keep-Alive": "1", "Proxy-Authorization": "Basic x", "X-Fine": "yes" },
      ...local(),
    });
    const headers = seen[0]!.headers;
    for (const name of ["expect", "upgrade", "te", "trailer", "keep-alive", "proxy-authorization"]) expect([name, headers[name]]).toEqual([name, undefined]);
    expect(headers["x-fine"]).toBe("yes");
  });

  it("CRLF in a header value or name is a GuardedHttpError, sends nothing, and leaves no timer behind", async () => {
    const started = Date.now();
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, headers: { "x-a": "v\r\nInjected: 1" }, ...local() }))).toBe("invalid-header");
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, headers: { "x-a\r\nInjected": "v" }, ...local() }))).toBe("invalid-header");
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, headers: { "x-a": "v\0" }, ...local() }))).toBe("invalid-header");
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, headers: { "x a": "v" }, ...local() }))).toBe("invalid-header");
    expect(seen).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("the environment proxy is not used", async () => {
    const hits: string[] = [];
    const net = await import("node:net");
    const proxy = net.createServer((socket) => socket.on("data", (chunk) => { hits.push(chunk.toString()); socket.destroy(); }));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as AddressInfo).port;
    const saved = { http: process.env.HTTP_PROXY, use: process.env.NODE_USE_ENV_PROXY };
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.NODE_USE_ENV_PROXY = "1";
    try {
      const response = await guardedRequest({ url: `http://mcp.example.test:${port}/`, resolver: async () => [{ address: "127.0.0.1" }], ...local() });
      expect(response.status).toBe(200);
      expect(hits).toEqual([]);
    } finally {
      if (saved.http === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = saved.http;
      if (saved.use === undefined) delete process.env.NODE_USE_ENV_PROXY; else process.env.NODE_USE_ENV_PROXY = saved.use;
      proxy.close();
    }
  });
});

describe("caps, timeouts and abort", () => {
  it("a body over the cap aborts (streamed, no content-length)", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(4096, 97);
      let sent = 0;
      const timer = setInterval(() => {
        res.write(chunk);
        sent += chunk.length;
        if (sent > 200_000) { clearInterval(timer); res.end(); }
      }, 1);
    };
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, kind: "metadata", maxBytes: 10_000, ...local() }))).toBe("body-too-large");
  });

  it("a declared content-length over the cap aborts early", async () => {
    handler = (_req, res) => { res.writeHead(200, { "content-length": "100000" }); res.write("x"); };
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, kind: "metadata", ...local() }))).toBe("body-too-large");
  });

  it("uses 64 KiB for metadata, token and register and 20 MiB for mcp by default", async () => {
    handler = (_req, res) => { res.writeHead(200); res.end(Buffer.alloc(70 * 1024, 1)); };
    for (const kind of ["metadata", "token", "register"] as const) {
      expect([kind, await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, kind, ...local() }))]).toEqual([kind, "body-too-large"]);
    }
    const ok = await guardedRequest({ url: `http://127.0.0.1:${port}/`, kind: "mcp", ...local() });
    expect(ok.body.length).toBe(70 * 1024);
  });

  it("a server that never answers times out at the total limit", async () => {
    handler = () => undefined;
    const started = Date.now();
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, totalMs: 150, ...local() }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("the abort signal stops a request in flight", async () => {
    handler = () => undefined;
    const controller = new AbortController();
    const pending = guardedRequest({ url: `http://127.0.0.1:${port}/`, signal: controller.signal, totalMs: 5_000, ...local() });
    setTimeout(() => controller.abort(), 50);
    expect(await codeOf(pending)).toBe("aborted");
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${port}/`, signal: controller.signal, ...local() }))).toBe("aborted");
  });

  it("a refused connection is unreachable", async () => {
    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    expect(await codeOf(guardedRequest({ url: `http://127.0.0.1:${deadPort}/`, ...local() }))).toBe("unreachable");
  });

  it("closing a stream on purpose, or a server that drops it, raises nothing uncaught", async () => {
    handler = (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: one\n\n"); };
    const response = await guardedRequest({ url: `http://127.0.0.1:${port}/`, kind: "sse", responseMode: "stream", ...local() });
    const iterator = response.stream[Symbol.asyncIterator]();
    await iterator.next();
    response.close();
    server.closeAllConnections();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dropped = await guardedRequest({ url: `http://127.0.0.1:${port}/`, kind: "sse", responseMode: "stream", ...local() }).catch(() => null);
    void dropped;
  });

  it("stream mode hands back a capped body stream", async () => {
    handler = (_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: hi\n\n"); };
    const response = await guardedRequest({ url: `http://127.0.0.1:${port}/`, kind: "sse", responseMode: "stream", ...local() });
    const chunks: Buffer[] = [];
    for await (const chunk of response.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("data: hi\n\n");

    handler = (_req, res) => { res.writeHead(200); res.end(Buffer.alloc(5_000, 1)); };
    const capped = await guardedRequest({ url: `http://127.0.0.1:${port}/`, kind: "sse", responseMode: "stream", maxBytes: 1_000, ...local() });
    await expect((async () => { for await (const chunk of capped.stream) void chunk; })()).rejects.toMatchObject({ code: "body-too-large" });
  });
});

describe("module hygiene", () => {
  const source = readFileSync(new URL("./guarded-http.mjs", import.meta.url), "utf8");
  it("never turns certificate checking off and never uses fetch", () => {
    expect(source).not.toMatch(/rejectUnauthorized/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(source).not.toMatch(/checkServerIdentity/);
  });
  it("keeps the test seams out of the public options and the declaration file", () => {
    expect(source).not.toMatch(/options\.(transportForTests|testHooks)/);
    const declaration = readFileSync(new URL("./guarded-http.d.mts", import.meta.url), "utf8");
    expect(declaration).not.toMatch(/transportForTests|testHooks|tamperAddress/);
  });
  it("chooses the address only through the custom lookup and carries the license header", () => {
    expect(source).toMatch(/lookup,\s*\n\s*agent: false/);
    expect(source).toContain("SPDX-License-Identifier: AGPL-3.0-or-later");
  });
});

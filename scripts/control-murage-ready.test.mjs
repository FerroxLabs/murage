// SPDX-License-Identifier: AGPL-3.0-or-later
// How launchVerificationServer decides the server is ready: a configurable
// allowance (default 120 s) and a probe that leaves no pooled socket behind.
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_READY_TIMEOUT_MS, probeVerificationHealth, verificationReadyTimeoutMs } from "./control-murage.ts";

describe("verification server ready allowance", () => {
  it("defaults to 120 seconds", () => {
    expect(DEFAULT_READY_TIMEOUT_MS).toBe(120_000);
    expect(verificationReadyTimeoutMs({}, {})).toBe(120_000);
  });
  it("takes the option first, then MURAGE_VERIFY_READY_TIMEOUT_MS", () => {
    expect(verificationReadyTimeoutMs({ readyTimeoutMs: 5_000 }, { MURAGE_VERIFY_READY_TIMEOUT_MS: "9000" })).toBe(5_000);
    expect(verificationReadyTimeoutMs({}, { MURAGE_VERIFY_READY_TIMEOUT_MS: "9000" })).toBe(9_000);
  });
  it("ignores a value that is not a positive whole number of milliseconds", () => {
    for (const bad of ["", "abc", "0", "-5", "1.5", "NaN"]) {
      expect(verificationReadyTimeoutMs({}, { MURAGE_VERIFY_READY_TIMEOUT_MS: bad })).toBe(120_000);
    }
  });
});

describe("verification health probe", () => {
  const servers = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))); });

  it("uses its own connection and closes it, so the caller's first request never reuses a probe socket", async () => {
    let connections = 0;
    const seen = [];
    const server = createServer((req, res) => {
      seen.push(String(req.headers.connection));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ app: "murage" }));
    });
    server.on("connection", () => { connections++; });
    servers.push(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    expect(await probeVerificationHealth(url, 1_000)).toBe(true);
    expect(await probeVerificationHealth(url, 1_000)).toBe(true);
    expect(connections).toBe(2);
    expect(seen).toEqual(["close", "close"]);
  });

  it("is false for a wrong app, a non-200 answer and a refused connection", async () => {
    const server = createServer((req, res) => { res.statusCode = req.url === "/api/health" ? 200 : 500; res.end(JSON.stringify({ app: "other" })); });
    servers.push(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    expect(await probeVerificationHealth(`http://127.0.0.1:${port}`, 1_000)).toBe(false);
    servers.splice(0).forEach((s) => s.close());
    expect(await probeVerificationHealth(`http://127.0.0.1:${port}`, 1_000)).toBe(false);
  });
});

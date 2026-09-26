// 0.1.60 audit C3: a managed Connected apps status failure reached the panel
// as "Connected apps: HTTP 503" or as the connection service's own raw text.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { connectedServices, connectionStatus, connectionStatusFailureSentence, setManagedBrokerAccess } from "./composio.ts";

let server: Server;
let answer = { status: 503, body: "upstream connect error or disconnect/reset before headers. reset reason: connection failure, transport failure reason: /srv/broker/pool" };

beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(answer.status, { "content-type": "text/plain" }); res.end(answer.body); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  setManagedBrokerAccess({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, token: "a".repeat(64) });
});
afterAll(async () => {
  setManagedBrokerAccess(null);
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe("Connected apps status failures in plain words", () => {
  it.each([[503, /aren't answering right now/], [502, /aren't answering right now/], [429, /too many requests/], [401, /didn't accept this computer's sign-in/], [400, /couldn't be checked/]] as const)("a managed %i", async (status, sentence) => {
    answer = { status, body: status === 429 ? JSON.stringify({ error: { message: "rate_limit_exceeded: bucket conn-7" } }) : answer.body };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const call of [() => connectionStatus({}, ["github"]), () => connectedServices({})]) {
        const error = await call().then(() => null, (e: Error) => e);
        expect(error?.message).toMatch(sentence);
        expect(error?.message).not.toMatch(/HTTP|\b[45]\d\d\b|upstream|rate_limit|\/srv/);
      }
      // The detail still reaches the log.
      expect(warn.mock.calls.flat().join(" ")).toContain(`HTTP ${status}`);
    } finally { warn.mockRestore(); }
  });
  it("every sentence is a plain sentence", () => {
    for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 503, 504]) expect(connectionStatusFailureSentence(status)).toMatch(/^[A-Z][^()]*\.$/);
  });
});

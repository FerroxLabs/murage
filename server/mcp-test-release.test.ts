// SPDX-License-Identifier: AGPL-3.0-or-later
// q1022-connparity: the Settings Test's own authority at the release door (mcp-test-release.ts), driven over HTTP as
// the wrapper drives it. End to end (the real wrapper, the booted server's door) it is witnessed by W4/W4b in
// connparity-settings-chat-1022.test.ts; this file pins the fail-closed edges a well-behaved wrapper never reaches.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestReleaseAuthority, TEST_RELEASE_BUDGET_BYTES, type TestRelease } from "./mcp-test-release.ts";

let server: Server;
let base = "";
let releases: ReturnType<typeof createTestReleaseAuthority>;
let fellThrough = 0;
const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

beforeEach(async () => {
  releases = createTestReleaseAuthority();
  fellThrough = 0;
  // the routing index.ts does: a token this table holds goes to the Test door, anything else to the turn door
  server = createServer((req, res) => {
    if (releases.owns(req.headers.authorization)) return void releases.door(req, res, json);
    fellThrough++;
    res.writeHead(409); res.end("turn door");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const post = (release: TestRelease, body: unknown, token = release.env.MURAGE_RELEASE_TOKEN) => fetch(base, {
  method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
}).then(async (res) => ({ status: res.status, text: await res.text() }));
const verdictBody = (release: TestRelease, sequence: number, frame: string) => ({
  instanceId: release.env.MURAGE_RELEASE_INSTANCE, sequence, descriptor: "proxy:wipeMcp:frame", requestId: JSON.parse(frame).id ?? null,
  bytes: Buffer.byteLength(frame), digest: createHash("sha256").update(frame).digest("hex"), frame,
});
const FRAME = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } });

describe("q1022-connparity: the Settings Test's release at the door", () => {
  it("a frame the door permitted is opened once, with the acknowledgement the wrapper waits for", async () => {
    const release = releases.open(base);
    expect((await post(release, { operation: "upstream", instanceId: release.env.MURAGE_RELEASE_INSTANCE, bytes: 64 })).status).toBe(200);
    const issued = await post(release, verdictBody(release, 1, FRAME));
    expect(issued.status).toBe(200);
    const opened = release.accept(issued.text);
    expect(opened).toEqual({ frame: FRAME, ack: { type: "turn-release-ack", instanceId: release.env.MURAGE_RELEASE_INSTANCE, sequence: 1 } });
    // the same envelope offered again is refused, and the release is over
    expect(() => release.accept(issued.text)).toThrow("TEST_RELEASE_REFUSED");
    expect(releases.owns(`Bearer ${release.env.MURAGE_RELEASE_TOKEN}`)).toBe(false);
  });

  it("a line the door never permitted is refused (a forged permit, another Test's envelope, a bare frame)", async () => {
    const release = releases.open(base);
    const other = releases.open(base);
    const foreign = await post(other, verdictBody(other, 1, FRAME));
    expect(() => release.accept(foreign.text)).toThrow("TEST_RELEASE_REFUSED");
    const second = releases.open(base);
    expect(() => second.accept(JSON.stringify({ permit: "A".repeat(43), instanceId: second.env.MURAGE_RELEASE_INSTANCE, sequence: 1, frame: FRAME }))).toThrow("TEST_RELEASE_REFUSED");
    const third = releases.open(base);
    expect(() => third.accept(FRAME)).toThrow("TEST_RELEASE_REFUSED");
  });

  it("past its byte allowance the door refuses, and stays closed for that Test", async () => {
    const release = releases.open(base);
    const reserve = (bytes: number) => post(release, { operation: "upstream", instanceId: release.env.MURAGE_RELEASE_INSTANCE, bytes });
    expect((await reserve(TEST_RELEASE_BUDGET_BYTES)).status).toBe(200);
    expect((await reserve(1)).status).toBe(409);
    expect((await reserve(0)).status).toBe(409);
    expect((await post(release, verdictBody(release, 1, FRAME))).status).toBe(409);
  });

  it("a request that is not exactly one of the two operations ends the Test's authority", async () => {
    for (const bad of [
      (r: TestRelease) => ({ ...verdictBody(r, 1, FRAME), descriptor: "proxy:remoteMcp:frame" }),
      (r: TestRelease) => ({ ...verdictBody(r, 1, FRAME), digest: "0".repeat(64) }),
      (r: TestRelease) => ({ ...verdictBody(r, 1, FRAME), instanceId: "someone-else" }),
      (r: TestRelease) => ({ operation: "upstream", instanceId: r.env.MURAGE_RELEASE_INSTANCE, bytes: -1 }),
      (r: TestRelease) => ({ operation: "upstream", instanceId: r.env.MURAGE_RELEASE_INSTANCE, bytes: 1, extra: true }),
    ]) {
      const release = releases.open(base);
      expect((await post(release, bad(release))).status).toBe(409);
      expect((await post(release, verdictBody(release, 1, FRAME))).status).toBe(409);
    }
  });

  it("when the Test ends its token is nothing: the request falls through to the turn door, which does not know it", async () => {
    const release = releases.open(base);
    release.dispose();
    expect(releases.owns(`Bearer ${release.env.MURAGE_RELEASE_TOKEN}`)).toBe(false);
    expect((await post(release, verdictBody(release, 1, FRAME))).status).toBe(409);
    expect(fellThrough).toBe(1);
  });
});

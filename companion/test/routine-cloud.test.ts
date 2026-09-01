// A routine is the way around the computer-provision denial.
//
// `POST /api/bots/:id/computer/provision` is denied to a phone outright, and
// `POST /api/bots/:id/computer/join` is denied unless the computer's owner has
// turned cloud access on for that specific device. But `POST /api/routines` is
// allowed, and a routine carrying `runOn: "cloud"` reaches the same
// `box.provisionBox()` call on its next run — server/index.ts computes
// `const wants = opts?.runOn === "cloud" ? "cloud" : bot.computer`, and the
// comment beside it says "cloud routine overrides the EMBER default".
//
// So a lost phone could stand up billable cloud infrastructure through a route
// whose allowance says "routines create ordinary tasks using an existing agent
// configuration". The discriminator is a field in the body, which a
// method-and-path allowlist cannot see, so the check lives in the proxy.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";

const TOKEN = "murage_test_token";

let harness: Server;
let sidecar: Server;
let sidecarPort = 0;
let cloudDesktopAccess = false;

/** Everything the stub harness was actually asked to do. A request that never
 * arrives is the property most of these tests are about. */
let received: Array<{ method: string; url: string; body: string; contentLength: string }> = [];

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );

const close = (server: Server | undefined): Promise<void> =>
  new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

const send = async (
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; text: string }> => {
  const res = await fetch(`http://127.0.0.1:${sidecarPort}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
  });
  return { status: res.status, text: await res.text() };
};

beforeAll(async () => {
  harness = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        contentLength: String(req.headers["content-length"] ?? ""),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const harnessPort = await listen(harness);

  sidecar = createServer(
    createProxyHandler({
      harnessPort,
      authenticate: (t) => (t === TOKEN ? { cloudDesktopAccess } : null),
      redeem: () => ({ error: "not used here" }),
      serverName: () => "Test computer",
    }),
  );
  sidecarPort = await listen(sidecar);
});

afterAll(async () => {
  await close(sidecar);
  await close(harness);
});

beforeEach(() => {
  received = [];
  cloudDesktopAccess = false;
});

describe("a routine that asks for the cloud", () => {
  it("never reaches the harness from a phone without cloud access", async () => {
    const { status, text } = await send(
      "POST",
      "/api/routines",
      JSON.stringify({ name: "nightly", runOn: "cloud", botId: "b1" }),
    );
    expect(status).toBe(403);
    expect(text).toContain("cloud routines are set up on your computer");
    // The refusal has to happen before forwarding, not after: the harness
    // creating the routine and the phone being told "no" is the worst outcome.
    expect(received).toEqual([]);
  });

  it("is refused on the amend route too, which is how an ember routine gets upgraded", async () => {
    // server/routines.ts resolves `patch.runOn ?? routine.runOn`, so a PATCH
    // is a full second way in and denying only the create closes half a hole.
    const { status } = await send(
      "PATCH",
      "/api/routines/routine_1",
      JSON.stringify({ runOn: "cloud" }),
    );
    expect(status).toBe(403);
    expect(received).toEqual([]);
  });

  it("is allowed once the computer's owner turns cloud access on for that phone", async () => {
    cloudDesktopAccess = true;
    const body = JSON.stringify({ name: "nightly", runOn: "cloud", botId: "b1" });
    const { status } = await send("POST", "/api/routines", body);
    expect(status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].body).toBe(body);
  });
});

describe("everything else still goes through untouched", () => {
  it("forwards an ordinary routine byte-for-byte, with a length that matches", async () => {
    // The body had to be read to be inspected, so it is replayed rather than
    // piped. Replaying the parse instead of the bytes would make the sidecar
    // the author of what the harness stores.
    const body = JSON.stringify({ name: "brief", runOn: "ember", note: "unicode: é 🙂" });
    const { status } = await send("POST", "/api/routines", body);
    expect(status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].body).toBe(body);
    // Not the character count — the byte count.
    expect(received[0].contentLength).toBe(String(Buffer.byteLength(body)));
  });

  it("forwards a routine with no runOn at all", async () => {
    const body = JSON.stringify({ name: "brief", botId: "b1" });
    const { status } = await send("POST", "/api/routines", body);
    expect(status).toBe(200);
    expect(received[0].body).toBe(body);
  });

  it("forwards an unparseable body and lets the harness be the one to refuse it", async () => {
    // It cannot create a cloud routine either — the harness reads it the same
    // way — so guessing here would only add a second opinion about JSON.
    const { status } = await send("POST", "/api/routines", "{not json");
    expect(status).toBe(200);
    expect(received[0].body).toBe("{not json");
  });

  it("still streams a body on a route that was never buffered", async () => {
    // The forwarding path became a closure to make the buffered case possible.
    // This is the regression guard on the ordinary, unbuffered one.
    const body = JSON.stringify({ text: "hello" });
    const { status } = await send("POST", "/api/groups/room-1/messages", body);
    expect(status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0].body).toBe(body);
  });

  it("leaves running an existing routine alone", async () => {
    // That routine was configured at the keyboard. Running it is within the
    // allowance; only authoring a cloud one is not.
    const { status } = await send("POST", "/api/routines/routine_1/run");
    expect(status).toBe(200);
    expect(received).toHaveLength(1);
  });
});

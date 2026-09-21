// The cloud computer is a machine the bot controls, and anything the bot
// reads can steer what lands on it. So the "frame" it hands back is untrusted
// in SIZE, not just in content: a single answer must never be able to make
// this process buffer an unbounded number of bytes.
//
// The property under test is specifically that the limit is enforced while
// the body is arriving. Content-length is a claim by the same box: it is
// absent on a chunked response and free to understate. A check that reads
// the header and then calls arrayBuffer() has already bought the whole
// response before it can refuse, so these tests drive a server that sends a
// chunked body with no length at all and assert the producer is cut off.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const CAP_BYTES = 8 * 1024 * 1024;
const CHUNK = Buffer.alloc(256 * 1024, 0x41);
/** What the hostile box is willing to send if nobody stops it. */
const FLOOD_BYTES = 32 * 1024 * 1024;
/** Enough slack for the socket and fetch's own read-ahead, far below FLOOD. */
const ACCEPTABLE_BYTES = 24 * 1024 * 1024;

type Scenario = "small" | "flood" | "declared-huge" | "files-oversized" | "files-small";

describe("box frame size limit", () => {
  let api: Server;
  let screenshotBox: typeof import("./box.ts").screenshotBox;
  let scenario: Scenario = "small";
  let flooded = 0;

  const cfg = { box: { token: "box_test" } } as any;

  beforeAll(async () => {
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      req.resume();
      if (url.pathname.endsWith("/commands")) {
        res.setHeader("content-type", "application/json");
        res.writeHead(200).end(JSON.stringify({ ok: true, exitCode: 0, stdout: "captured", stderr: "" }));
        return;
      }
      if (url.pathname.endsWith("/artifacts")) {
        if (scenario === "small") {
          res.writeHead(200, { "content-type": "image/jpeg" }).end(Buffer.from("tiny-frame"));
          return;
        }
        if (scenario === "declared-huge") {
          // A length that is over the cap on its own: refused before a byte
          // of the body is read.
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(FLOOD_BYTES) });
          res.end(Buffer.alloc(0));
          return;
        }
        if (scenario === "flood") {
          // Chunked: NO content-length, so the header check cannot help.
          res.writeHead(200, { "content-type": "image/jpeg" });
          let cut = false;
          res.on("close", () => (cut = true));
          const pump = () => {
            while (!cut && flooded < FLOOD_BYTES) {
              flooded += CHUNK.length;
              if (!res.write(CHUNK)) {
                res.once("drain", pump);
                return;
              }
            }
            if (!cut) res.end();
          };
          pump();
          return;
        }
        // The files-API scenarios exercise the fallback route.
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
        return;
      }
      if (url.pathname.endsWith("/files")) {
        const raw = scenario === "files-oversized" ? Buffer.alloc(CAP_BYTES + 1024, 0x42) : Buffer.from("tiny-frame");
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ ok: true, content: raw.toString("base64") }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as any).port;
    vi.stubEnv("MURAGE_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    ({ screenshotBox } = await import("./box.ts"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("still returns an ordinary frame", async () => {
    scenario = "small";
    await expect(screenshotBox(cfg, "bot-1", "box-1")).resolves.toEqual({
      png: Buffer.from("tiny-frame").toString("base64"),
      format: "jpeg",
    });
  });

  it("refuses a length the box declares over the cap", async () => {
    scenario = "declared-huge";
    await expect(screenshotBox(cfg, "bot-1", "box-1")).rejects.toThrow(/8 MB limit/);
  });

  it("cuts off a chunked flood instead of buffering it", async () => {
    scenario = "flood";
    flooded = 0;
    await expect(screenshotBox(cfg, "bot-1", "box-1")).rejects.toThrow(/8 MB limit/);
    // The refusal must arrive while the box is still sending. If the whole
    // response had been bought first, `flooded` would have reached FLOOD_BYTES.
    expect(flooded).toBeGreaterThan(0);
    expect(flooded).toBeLessThan(ACCEPTABLE_BYTES);
  }, 60_000);

  it("refuses an oversized frame smuggled through the files API envelope", async () => {
    scenario = "files-oversized";
    await expect(screenshotBox(cfg, "bot-1", "box-1")).rejects.toThrow(/8 MB limit/);
  });

  it("still reads an ordinary frame back over the files API", async () => {
    scenario = "files-small";
    await expect(screenshotBox(cfg, "bot-1", "box-1")).resolves.toEqual({
      png: Buffer.from("tiny-frame").toString("base64"),
      format: "jpeg",
    });
  });
});

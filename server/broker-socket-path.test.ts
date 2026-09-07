import { createServer, connect } from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { brokerSocketPath } from "./procs.ts";

it.skipIf(process.platform === "win32")("keeps deeply nested and multibyte broker paths within a conservative UNIX socket limit", async () => {
  const root = join(tmpdir(), "非常に長い保存先".repeat(20));
  const path = brokerSocketPath(root, randomUUID());
  expect(Buffer.byteLength(path)).toBeLessThan(104);
  const server = createServer(socket => socket.end("permission-fixture"));
  try {
    const ready = once(server, "listening");
    server.listen(path);
    await ready;
    const client = connect(path);
    const data = await once(client, "data");
    expect(String(data[0])).toBe("permission-fixture");
    client.destroy();
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it.skipIf(process.platform === "win32")("shortens with full installation and tag identity, not a shared truncated prefix", () => {
  const prefix = join(tmpdir(), "long-root".repeat(20));
  const first = brokerSocketPath(`${prefix}-a`, "same-tag");
  expect(first).toBe(brokerSocketPath(`${prefix}-a`, "same-tag"));
  expect(first).not.toBe(brokerSocketPath(`${prefix}-b`, "same-tag"));
  expect(first).not.toBe(brokerSocketPath(`${prefix}-a`, "different-tag"));
});

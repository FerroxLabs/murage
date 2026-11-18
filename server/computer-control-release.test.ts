import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { boundProxyState, spawnBoundProxy } from "./testing/bound-proxy-fixture.ts";

it.each([401, 403])("computer control authorization failure %i seals the bound session without releasing backend content", async status => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++; req.resume();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "private fixture backend detail" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const child = await spawnBoundProxy("computer", process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./computer-proxy.ts", import.meta.url))], {
    env: { ...process.env, MURAGE_CONTROL_URL: `http://127.0.0.1:${port}/control`, MURAGE_CONTROL_TOKEN: "fixture-control", MURAGEBOX_BOX_ID: "fixture-box" },
  });
  const output: string[] = [];
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.resume();
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await expect.poll(() => output.some(frame => frame.includes('"id":1')), { timeout: 5000 }).toBe(true);
    output.length = 0;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "screenshot", arguments: {} } }) + "\n");
    await expect.poll(() => boundProxyState(child).sealed, { timeout: 5000 }).toBe(true);
    expect(boundProxyState(child).refusals).toBe(1);
    expect(calls).toBe(1);
    expect(output).toEqual([]);
  } finally {
    child.kill(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

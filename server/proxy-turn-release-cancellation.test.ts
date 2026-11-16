import { expect, it } from "vitest";
import { runBoundBridge } from "./testing/bound-proxy-fixture.ts";

// Exercise the real fetch, upstream reader, release verdict and final ingress in
// an isolated child. Abort-looking transport errors must still seal without a
// caller signal; timeouts also remain transport failures.
it.each(["headers", "body", "request-input", "custom-reason", "transport", "body-transport", "timeout"] as const)(
  "proxy upstream %s preserves the caller-cancel / transport-loss boundary", async mode => {
    const cancelled = ["headers", "body", "request-input", "custom-reason"].includes(mode);
    const script = `
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { proxyFetch, sendProxyFrame } from ${JSON.stringify(new URL("./proxy-turn-release.ts", import.meta.url).href)};
const mode = ${JSON.stringify(mode)};
createInterface({ input: process.stdin }).on("line", async line => {
  const request = JSON.parse(line);
  const controller = new AbortController();
  const server = createServer((req, res) => {
    if (mode === "transport") { req.socket.destroy(); return; }
    if (mode === "timeout") { controller.abort(new DOMException("deadline", "TimeoutError")); return; }
    if (mode === "body" || mode === "body-transport") { res.writeHead(200); res.write("partial"); return; }
    controller.abort(mode === "custom-reason" ? new Error("caller withdrew") : undefined);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  let rejected = false;
  try {
    const response = await (mode === "request-input"
      ? proxyFetch("computer", new Request(url, { signal: controller.signal }))
      : proxyFetch("computer", url, { signal: controller.signal }));
    if (mode === "body" || mode === "body-transport") {
      const reading = response.text();
      if (mode === "body") controller.abort();
      else server.closeAllConnections();
      await reading;
    }
  } catch { rejected = true; }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (!rejected) throw new Error("expected rejected upstream");
  // Even a helper attempting a normal fallback cannot beat the transport latch.
  sendProxyFrame("computer", { jsonrpc: "2.0", id: request.id, result: { tools: [] } });
});`;
    const output = await runBoundBridge(script, [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })], cancelled ? 1 : 0, false, { role: "computer" });
    expect(output).toEqual(cancelled ? ['{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'] : []);
  }, 15_000,
);

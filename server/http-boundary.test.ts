import { request } from "node:http";
import { describe, expect, it } from "vitest";

import { launchVerificationServer } from "../scripts/control-murage.ts";

// fetch normalizes/rejects malformed URLs before sending them. Keep the raw
// request target intact, and exercise the real Node listener in its own process.
async function rawGet(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body }));
      res.on("error", reject);
    });
    req.setTimeout(3_000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

describe("malformed request targets stay inside the HTTP boundary", () => {
  it.each([
    { listener: "harness", offset: 0, health: "/api/health", app: "murage" },
    { listener: "webhooks", offset: 1, health: "/health", app: "murage-webhooks" },
  ])("$listener survives malformed targets and still serves health", async ({ offset, health, app }) => {
    const fixture = await launchVerificationServer();
    console.info("HTTP boundary fixture", fixture.info);
    const port = Number(new URL(fixture.info.url).port) + offset;
    try {
      for (const target of ["http://[", "http://127.0.0.1:bad/", "//["]) {
        const response = await rawGet(port, target);
        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "Invalid request target" });
        const healthy = await rawGet(port, health);
        expect(healthy.status).toBe(200);
        expect(JSON.parse(healthy.body)).toMatchObject({ app });
        expect(fixture.child.exitCode).toBeNull();
        expect(fixture.child.signalCode).toBeNull();
        if (offset === 0) expect(JSON.parse(healthy.body).pid).toBe(fixture.info.pid);
      }
      // Valid absolute-form targets continue to route normally.
      expect((await rawGet(port, `http://localhost:${port}${health}?probe=1`)).status).toBe(200);
      expect((await rawGet(port, "/no-such-boundary-test-route")).status).toBe(404);
      if (offset === 0) {
        expect((await rawGet(port, health, { host: "evil.example" })).status).toBe(403);
        expect((await rawGet(port, health, { origin: "https://evil.example" })).status).toBe(403);
      }
    } finally {
      await fixture.close();
    }
  }, 30_000);
});

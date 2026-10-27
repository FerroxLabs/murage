// Owner HTTP responses, with the real server and a loopback-only box stub.
// All credentials and error bodies below are synthetic fixture markers.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { errorTextCases, ERROR_TEXT_LEAK } from "./testing/error-text-fixtures.ts";

describe("box error text in owner HTTP responses", () => {
  let api: Server;
  let fixture: VerificationServer;
  let headers: Record<string, string>;
  let botId: string;
  let boxName = "";
  let output = "";

  beforeAll(async () => {
    api = createServer((req, res) => {
      req.resume();
      const path = new URL(req.url ?? "/", "http://fixture.test").pathname;
      const box = { id: "fixture-box", name: boxName, state: "ready" };
      res.setHeader("content-type", "application/json");
      if (path.endsWith("/commands")) {
        res.end(JSON.stringify({ exitCode: 1, stdout: output, stderr: output }));
      } else if (path === "/boxes") {
        res.end(JSON.stringify({ boxes: [box] }));
      } else if (path === "/boxes/fixture-box") {
        res.end(JSON.stringify({ box }));
      } else res.writeHead(404).end("{}");
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    fixture = await launchVerificationServer({}, undefined, {
      portRange: { from: 18_799, span: 10_000 },
      instrumentationSource: `
        import { readFileSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        process.env.MURAGE_BOX_API = ${JSON.stringify(base)};
        const path = join(process.env.MURAGE_DATA_DIR, "config.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.box = { token: "fixture-token" };
        writeFileSync(path, JSON.stringify(config));
      `,
    });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const instances = await (await fetch(`${fixture.info.url}/api/instances`, { headers })).json() as any;
    const model = instances.instances.find((instance: any) => instance.instanceId === "verification").models.options[0].id;
    const created = await fetch(`${fixture.info.url}/api/bots`, {
      method: "POST", headers,
      body: JSON.stringify({ name: "Error text fixture", modelSelection: { instanceId: "verification", model } }),
    });
    expect(created.status).toBe(201);
    botId = ((await created.json()) as { bot: { id: string } }).bot.id;
    boxName = `muragebox-${botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${createHash("sha256").update(botId).digest("hex").slice(0, 6)}`;
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
    if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  for (const site of ["exec", "screenshot"] as const) {
    it.each(errorTextCases())(`redacts whole ${site} output before the HTTP display cut: $name`, async ({ raw, name }) => {
      output = raw;
      const response = await fetch(`${fixture.info.url}/api/bots/${botId}/computer/${site}`, {
        method: "POST", headers, body: JSON.stringify({ command: "fixture" }),
      });
      expect(response.status).toBe(site === "exec" ? 200 : 500);
      const body = await response.json() as { exitCode?: number; stdout?: string; stderr?: string; error?: string };
      expect(JSON.stringify(body)).not.toMatch(ERROR_TEXT_LEAK);
      const fields = site === "exec" ? [body.stdout, body.stderr] : [body.error];
      if (site === "exec") {
        expect(body.exitCode).toBe(1);
        expect(body.stdout!.length).toBeLessThanOrEqual(4000);
        expect(body.stderr!.length).toBeLessThanOrEqual(2000);
      } else expect(body.error!.length).toBeLessThanOrEqual(200);
      for (const text of fields) {
        if (name === "short diagnostic") expect(text).toBe(raw);
        else expect(text).toContain("redacted");
      }
    });
  }
});

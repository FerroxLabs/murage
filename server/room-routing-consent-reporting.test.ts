// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import ts from "typescript";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { checkerAvailabilityFor } from "./browser-extension-check-availability.ts";

let fixture: VerificationServer;
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, {
    readyTimeoutMs: 180_000,
    instrumentationSource: `import { readFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; const path = join(process.env.MURAGE_DATA_DIR, 'config.json'); const config = JSON.parse(readFileSync(path, 'utf8')); config.flux = { apiKey: 'sk-flux-' + 'a'.repeat(64) }; writeFileSync(path, JSON.stringify(config));`,
  });
}, 190_000);
afterAll(async () => { await fixture?.close(); });

it("ROOM-ROUTING-CONSENT fresh config with a Flux key reports no checker until the owner chooses", async () => {
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(fixture.info.url + path, init);
    expect(response.ok).toBe(true);
    return await response.json() as any;
  };
  const secret = await request("/api/desktop-secret");
  const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret.secret };
  expect((await request("/api/config", { headers })).flux.configured).toBe(true);
  const { bot } = await request("/api/bots", { method: "POST", headers, body: JSON.stringify({ name: "Consent fixture" }) });
  expect(bot.browserActionCheck).toBeUndefined();
  const report = await request(`/api/bots/${bot.id}/browser-extension/mode`, { headers });
  expect(report.checkerAvailable).toBe(false);
  expect(report.checkerSource).toBeUndefined();
  expect(report.actionCheck).toBeUndefined();
});

it("ROOM-ROUTING-CONSENT prompt reports the local approval path with a Flux key and no saved choice", () => {
  // Execute the production function with its real resolver and fixture dependencies, without starting a second server.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "extensionPromptOptions");
  expect(declaration).toBeDefined();
  const js = ts.transpile(declaration!.getText(file), { target: ts.ScriptTarget.ES2022 });
  const prompt = new Function("checkerAvailabilityFor", "registry", "fluxConfigured", `${js}; return extensionPromptOptions;`)(
    (input: Parameters<typeof checkerAvailabilityFor>[0]) => checkerAvailabilityFor({ ...input, readKey: () => "sk-flux-" + "a".repeat(64), noRetainDeployed: true }),
    { instances: () => [] }, () => true,
  );
  expect(prompt({})).toEqual({ mode: "task", checker: "off" });
  expect(prompt({ browserActionCheck: "flux" })).toEqual({ mode: "task", checker: "on" });
});

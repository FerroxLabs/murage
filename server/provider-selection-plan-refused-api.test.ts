// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot picked a model the ChatGPT plan refused: through the real server (launchVerificationServer, the production index.ts) a turn
// request answers 409 with the plain plan line (code "model") from selectedProviderRoute, even though the catalog is silent.
// The plan sign-in arrives the way the desktop sends it (a murage:model-signin message on the server's parent port); the saved
// refusal is the file the server itself writes (chatgpt-refused-models.json). A sign-in of a new revision lifts the refusal.
// Synthetic fixture text only; loopback server, no network or credentials.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
const PLAN_MODEL_UNAVAILABLE = "This model isn't available on your ChatGPT plan. Choose another model."; // literal on purpose: the witness pins the owner-visible line

const posixOnly = describe.skipIf(process.platform === "win32");
const MODEL = "gpt-5.5";
let fixture: VerificationServer, headers: Record<string, string>;

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: (await response.json()) as any };
};
const signIn = (revision: string) => fixture.child.send({ type: "murage:model-signin", entries: [{ provider: "chatgpt", connectionId: "signin-chatgpt", revision, state: "connected", accessToken: "fixture-token", expiresAt: Date.now() + 3_600_000 }] });
const connectionRevision = async () => {
  let last = "";
  for (let i = 0; i < 100; i++) {
    const listed = await call("GET", "/api/provider-connections"); last = JSON.stringify(listed).slice(0, 600);
    const row = listed.body.connections?.find((c: any) => c.id === "signin-chatgpt");
    if (row) return row.revision as string;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`sign-in never reached the server: ${last} ${readFileSync(fixture.info.logPath, "utf8").slice(-1500)}`);
};

posixOnly("a ChatGPT plan-refused model through the real server", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      // The desktop parent port: messages from the test's IPC channel reach the server's own desktop-message handler.
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      writeFileSync(join(process.env.MURAGE_DATA_DIR, "chatgpt-refused-models.json"), JSON.stringify({ revision: "r1", models: [${JSON.stringify(MODEL)}] }), { mode: 0o600 });
      // The ChatGPT plan model list the connection reads on a refresh (loopback stub: no network): one chat model the plan lists.
      // The server reads config.json after this runs: a second engine that takes ChatGPT plan connections (the fixture engine is Claude Code, which does not).
      const configPath = join(process.env.MURAGE_DATA_DIR, "config.json");
      const config = JSON.parse((await import("node:fs")).readFileSync(configPath, "utf8"));
      config.instances["plan-engine"] = { driver: "codex", displayName: "Plan engine fixture", config: { ...config.instances.verification.config } };
      writeFileSync(configPath, JSON.stringify(config));
      // The gateway learns a plan refusal from the upstream's 400 for a model; the same recordPlanModelRefusal call is made here on the
      // server's own ModelSignIns (captured from its first sign-in message) when the test asks, since the gateway key is engine-private.
      const { ModelSignIns } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "model-signin.ts")).href)});
      let signIns;
      const apply = ModelSignIns.prototype.apply;
      ModelSignIns.prototype.apply = function (message) { signIns = this; return apply.call(this, message); };
      process.on("message", data => { if (data?.type === "test:plan-refusal") signIns.recordPlanModelRefusal?.(data.revision, data.model); });
      const realFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => String(input?.url ?? input).includes("codex/models")
        ? Promise.resolve(new Response(JSON.stringify({ models: [{ slug: ${JSON.stringify(MODEL)}, display_name: "Plan model", visibility: "list" }] }), { status: 200, headers: { "content-type": "application/json" } }))
        : realFetch(input, init);
      process.parentPort = { on: (_event, listener) => { process.on("message", data => listener({ data })); },
        // The desktop shell is handed the surface secret over this port (there is no /api/desktop-secret then): park it for the test.
        postMessage: message => { if (message?.type === "murage:desktop-secret") writeFileSync(join(process.env.MURAGE_DATA_DIR, "parent-port-secret.txt"), String(message.secret), { mode: 0o600 }); } };
    ` });
    const secretPath = join(fixture.info.dataDir, "parent-port-secret.txt");
    for (let i = 0; i < 100 && !existsSync(secretPath); i++) await new Promise(resolve => setTimeout(resolve, 100));
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": readFileSync(secretPath, "utf8") };
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("refuses the pick 409 with the plan line while the sign-in revision is the refused one, and with the ordinary line after a new sign-in", async () => {
    signIn("r1");
    expect(await connectionRevision()).toBe("r1");
    const pick = { name: "Plan bot", modelSelection: { instanceId: "verification", model: MODEL, connectionId: "signin-chatgpt" } };
    const refused = await call("POST", "/api/bots", pick);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toBe(PLAN_MODEL_UNAVAILABLE);

    signIn("r2");
    for (let i = 0; i < 100 && (await connectionRevision()) !== "r2"; i++) await new Promise(resolve => setTimeout(resolve, 100));
    const lifted = await call("POST", "/api/bots", pick);
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(409);
    expect(lifted.body.error).not.toBe(PLAN_MODEL_UNAVAILABLE);
    expect(lifted.body.error).toMatch(/not listed|could not be confirmed/);
  });

  // A bot saved while the plan listed the model, then the plan refused it (the gateway's recorded refusal for the current sign-in revision):
  // the turn dispatch (POST /api/bots/:id/messages -> turnRouting -> selectedProviderRoute) refuses 409 with the plan line, and the
  // refused send leaves the thread without the owner's message.
  it("refuses a saved bot's next turn at dispatch with the plan line and records no message", async () => {
    signIn("r2");
    for (let i = 0; i < 100 && (await connectionRevision()) !== "r2"; i++) await new Promise(resolve => setTimeout(resolve, 100));
    await call("POST", "/api/provider-connections/signin-chatgpt/refresh");
    let listed = false;
    for (let i = 0; i < 100 && !listed; i++) { listed = JSON.stringify((await call("GET", "/api/provider-connections/signin-chatgpt/catalog")).body).includes(MODEL); if (!listed) await new Promise(resolve => setTimeout(resolve, 100)); }
    expect(listed, "the stubbed plan list reached the catalog").toBe(true);
    const created = await call("POST", "/api/bots", { name: "Dispatch bot", modelSelection: { instanceId: "plan-engine", model: MODEL, connectionId: "signin-chatgpt" } });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const bot = created.body.bot ?? created.body;

    fixture.child.send({ type: "test:plan-refusal", revision: "r2", model: MODEL });
    for (let i = 0; i < 100 && JSON.stringify((await call("GET", "/api/provider-connections/signin-chatgpt/catalog")).body).includes(MODEL); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const send = await call("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "Fixture question" });
    expect(send.status, JSON.stringify(send.body)).toBe(409);
    expect(send.body.error).toBe(PLAN_MODEL_UNAVAILABLE);
    const thread = await call("GET", `/api/threads/${bot.threadId}/messages`);
    expect(JSON.stringify(thread.body)).not.toContain("Fixture question");
  });
});

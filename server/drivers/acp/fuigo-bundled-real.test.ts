// Opt-in release smoke: run in a network-disabled Linux container with the
// staged binary. All homes, stores, model replies and credentials are fixtures.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../../../scripts/control-murage.ts";
import { ensureDirs } from "../../config.ts";
import { EngineManager } from "../../engine-management.ts";
import { QUALIFIED_FUIGO_VERSION } from "../../fuigo-native-update.ts";
import { recordEvents } from "../../testing/events.ts";
import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
import { FuigoAgentDriver } from "./fuigo.ts";

const binary = process.env.FUIGO_BUNDLED_SMOKE_BINARY;
const output = process.env.FUIGO_BUNDLED_SMOKE_OUT;
useOutsideStoreFixture();

it.skipIf(process.platform !== "linux" || !binary)("runs the pinned bundled Fuigo, reports it current, and completes an offline model turn", async () => {
  const proof = JSON.parse(readFileSync(new URL("../../../scripts/fuigo-1.0.43-provenance.json", import.meta.url), "utf8"));
  const pin = proof.packages.find((row: { target: string }) => row.target === "linux-x64");
  const digest = () => createHash("sha256").update(readFileSync(binary!)).digest("hex");
  expect(digest()).toBe(pin.binarySha256);
  const version = execFileSync(binary!, ["--version"], { windowsHide: true, encoding: "utf8", timeout: 20_000 }).trim();
  expect(version).toBe(`fuigo ${proof.version} (${proof.source.slice(0, 12)})`);
  expect(QUALIFIED_FUIGO_VERSION).toBe(proof.version);
  expect(JSON.parse(readFileSync(join(dirname(binary!), "manifest.json"), "utf8"))).toMatchObject({
    version: proof.version, binarySha256: pin.binarySha256, tarballSha256: pin.tarballSha256,
  });

  const fixture = await launchVerificationServer(process.env, undefined, { separateHome: true });
  let driver: Awaited<ReturnType<typeof FuigoAgentDriver.create>> | undefined;
  let events: ReturnType<typeof recordEvents> | undefined;
  let requests = 0;
  const model = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model", owned_by: "fixture" }] }));
      return;
    }
    if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests++;
    const message = { role: "assistant", content: "FUIGO_BUNDLED_SMOKE_OK" };
    const base = { id: "chatcmpl-fixture", created: 0, model: "fixture-model" };
    if (body.stream) {
      res.setHeader("content-type", "text/event-stream");
      for (const [delta, finish_reason] of [[message, null], [{}, "stop"]]) {
        res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }] }));
    }
  });
  try {
    const control = (args: string[]) => runControlMurage([...args, "--url", fixture.info.url], { env: { ...process.env, MURAGE_DATA_DIR: fixture.info.dataDir } });
    const doctor = await control(["doctor"]);
    expect(doctor).toMatchObject({ ok: true });
    const created = await control(["new-bot", "--name", "Bundled smoke fixture"]) as { bot: { id: string } };
    await control(["send", "--bot", created.bot.id, "--text", "hello from the bundled smoke fixture"]);
    const settled = await control(["wait", "--bot", created.bot.id, "--timeout", "30"]);
    expect(settled).toMatchObject({ status: "settled" });
    const transcript = await control(["messages", "--bot", created.bot.id, "--limit", "10"]) as { messages: Array<{ role?: string }> };
    expect(transcript.messages.some(message => message.role === "bot")).toBe(true);
    const fetcher = async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://registry.npmjs.org/fuigo/latest");
      return Response.json({ name: "fuigo", version: proof.version });
    };
    const manager = new EngineManager({
      root: fixture.info.dataDir, platform: "linux", arch: "x64", fetch: fetcher as typeof fetch,
      getInstance: async () => ({ instanceId: "fuigo", driverKind: "fuigo", bundledCli: binary!, defaultSource: "bundled", snapshot: { state: "available", version } }),
      isBusy: () => false, activate: async () => { throw new Error("Smoke must not install an engine"); },
    });
    const status = await manager.check("fuigo");
    expect(status).toMatchObject({ source: "bundled", installedVersion: proof.version, latestVersion: proof.version, updateAvailable: false, releaseSupported: true });

    await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
    const port = (model.address() as { port: number }).port;
    const home = join(fixture.info.dataDir, "real-engine-home");
    const cwd = join(home, "work");
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(home, ".fuigo", "config.toml"), [
      '[model."bundled-smoke"]', 'model = "fixture-model"', `base_url = "http://127.0.0.1:${port}/v1"`,
      'name = "Offline smoke"', 'env_key = "FIXTURE_MODEL_KEY"', 'api_backend = "chat_completions"', "",
    ].join("\n"));
    ensureDirs();
    driver = await FuigoAgentDriver.create({ instanceId: "fuigo-bundled-smoke", displayName: "Fuigo", enabled: true,
      environment: { HOME: home, USERPROFILE: home, FUIGO_HOME: join(home, ".fuigo"), FIXTURE_MODEL_KEY: "fixture-only", FUIGO_API_KEY: "sk-flux-fixture-only" },
      config: { cli: binary!, fullAuto: false },
    });
    events = recordEvents(driver.adapter);
    const started = await driver.adapter.sendTurn({ cwd, threadId: "bundled-smoke", model: "bundled-smoke", text: "Reply with the smoke marker. Do not use tools." });
    const trust = await events.until(event => event.type === "request.opened" && event.turnId === started.turnId, 15_000);
    expect(trust).toMatchObject({ type: "request.opened", requestType: "question", folderTrust: { folder: cwd } });
    if (trust.type !== "request.opened" || trust.folderTrust?.folder !== cwd) throw new Error("Unexpected smoke request");
    expect(await driver.adapter.respondToRequest("bundled-smoke", trust.requestId!, {
      behavior: "answer", answers: [{ id: "folderTrust", selected: ["Trust this folder"] }],
    })).not.toBe("unavailable");
    const completed = await events.until(event => event.type === "turn.completed" && event.turnId === started.turnId, 60_000);
    expect(completed).toMatchObject({ ok: true });
    const text = events.events.flatMap(event => event.type === "content.delta" && event.streamKind === "assistant_text" ? [event.delta] : []).join("");
    expect(text).toContain("FUIGO_BUNDLED_SMOKE_OK");
    expect(requests).toBeGreaterThan(0);
    expect(digest()).toBe(pin.binarySha256);
    if (output) {
      copyFileSync(fixture.info.logPath, join(dirname(output), "fixture-server.log"));
      writeFileSync(output, JSON.stringify({ version, sha256: digest(), manifest: "matches pin", doctor, settled, transcript, update: status, completed, text, modelRequests: requests, fixtureLog: fixture.info.logPath }, null, 2) + "\n");
    }
  } finally {
    events?.stop();
    await driver?.dispose();
    model.closeAllConnections();
    if (model.listening) await new Promise<void>(resolve => model.close(() => resolve()));
    await fixture.close();
  }
}, 180_000);

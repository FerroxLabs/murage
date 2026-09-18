// The Computer panel's "Stop using this computer" is two harness calls, and
// this is the proof they actually stop a bot that is on the host desktop —
// including a bot on Auto, which is the default and which the local-computer
// interrupt sweep does not reach.
//
// Drives the real server over HTTP with the isolated fake Claude CLI. It
// cannot type on a real screen here, so what is proven is the authority: the
// person's hold refuses the next host-computer action, and the stop ends the
// turn. What is NOT provable — an action already inside the desktop driver is
// awaited, not aborted (server/host-computer-broker.ts) — is why the control's
// wording never claims the screen is safe.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string> = {};
let model: string;

const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const isBusy = async (botId: string) =>
  (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId).busy === true;
const promptReachedEngine = async (text: string) => {
  await expect
    .poll(() => existsSync(fixture.fixtureDumpPath) && readFileSync(fixture.fixtureDumpPath, "utf8").includes(text), { timeout: 15_000 })
    .toBe(true);
};
/** A bot left on Auto — the default, and on macOS the host desktop. */
const createAutoBot = async (name: string) =>
  (await api("POST", "/api/bots", { name, modelSelection: { instanceId: "verification", model } })).body.bot;

const holdATurn = async (bot: any, text: string) => {
  rmSync(fixture.fixtureDumpPath, { force: true });
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId })).status).toBe(202);
  await promptReachedEngine(text);
  expect(await isBusy(bot.id)).toBe(true);
};

beforeAll(async () => {
  fixture = await launchVerificationServer({});
  const proof = await api("GET", "/api/desktop-secret");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  const engines = (await api("GET", "/api/instances")).body.instances;
  model = engines.find((engine: any) => engine.instanceId === "verification").models.options[0].id;
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

it("the panel's stop takes the screen back and ends the turn of a bot left on Auto", async () => {
  const bot = await createAutoBot("Desktop stop Auto");
  expect(bot.computer).toBeUndefined();
  await holdATurn(bot, "__fixture_hold_authority__ typing into my editor");

  // Step one: the person takes the screen. This is what the harness honours
  // BEFORE the engine has finished dying — `/api/internal/host-computer`
  // refuses while any bot on Auto or "local" is held.
  const taken = await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" });
  expect(taken.status).toBe(200);
  expect(taken.body.held).toBe(true);
  // Still working: taking the screen refuses the next action, it does not end
  // the turn. That is exactly why the control does both.
  expect(await isBusy(bot.id)).toBe(true);

  // Step two: end the turn, so nothing further can be dispatched at all.
  const stopped = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId });
  expect(stopped.status).toBe(200);
  await expect.poll(() => isBusy(bot.id), { timeout: 10_000 }).toBe(false);

  // The hold survives the stop, so a late action cannot land while the person
  // is still at the keyboard; handing it back is their own separate choice.
  expect((await api("GET", `/api/bots/${bot.id}/computer/control`)).body.held).toBe(true);
  expect((await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" })).body.held).toBe(false);
  await api("DELETE", `/api/bots/${bot.id}`);
}, 60_000);

it("reports honestly when the stop names a different thread: the harness refuses and the bot keeps working", async () => {
  const bot = await createAutoBot("Desktop stop mismatch");
  await holdATurn(bot, "__fixture_hold_authority__ still typing");

  // A stale threadId is the shape of failure the control must not paper over.
  const refused = await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: "not-this-thread" });
  expect(refused.status).not.toBe(200);
  expect(await isBusy(bot.id)).toBe(true);

  expect((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status).toBe(200);
  await expect.poll(() => isBusy(bot.id), { timeout: 10_000 }).toBe(false);
  await api("DELETE", `/api/bots/${bot.id}`);
}, 60_000);

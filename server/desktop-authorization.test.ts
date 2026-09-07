import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let desktop: Record<string, string>;
let botId: string;
let groupId: string;
const remote = { "x-murage-companion": "1" };

const administration: Array<[string, string]> = [
  ["PATCH", "/api/config"], ["PUT", "/api/config"],
  ["PATCH", "/api/bots/{bot}"], ["DELETE", "/api/bots/{bot}"],
  ["POST", "/api/bots/{bot}/always-allow"],
  ["PATCH", "/api/groups/{group}"], ["DELETE", "/api/groups/{group}"], ["PATCH", "/api/groups/{group}/setup"],
  ["POST", "/api/teams/import"], ["POST", "/api/teams/export"], ["POST", "/api/team-library/github"],
  ["POST", "/api/bots/{bot}/assistant-profile"], ["POST", "/api/bots/{bot}/skills"], ["POST", "/api/bots/{bot}/skills/library"],
  ["PATCH", "/api/bots/{bot}/skills/example"], ["DELETE", "/api/bots/{bot}/skills/example"],
  ["PUT", "/api/section-context?section="], ["PUT", "/api/bots/{bot}/memory"], ["POST", "/api/bots/{bot}/checkpoints/restore"],
  ...["pull", "run", "start", "stop", "remove", "interrupt", "screenshot"].map((action): [string, string] => ["POST", `/api/local-computer/${action}`]),
  ...["run", "stop", "remove", "screenshot"].map((action): [string, string] => ["POST", `/api/bots/{bot}/local-computer/${action}`]),
  ...["provision", "sleep", "exec", "screenshot", "remove", "control", "viewer-close"].map((action): [string, string] => ["POST", `/api/bots/{bot}/computer/${action}`]),
  ["POST", "/api/cli-test"], ["PATCH", "/api/instances/verification"],
  ["POST", "/api/mcp/servers"], ["POST", "/api/mcp/servers/example/test"],
  ["PUT", "/api/mcp/servers/example"], ["PATCH", "/api/mcp/servers/example"], ["DELETE", "/api/mcp/servers/example"],
  ["POST", "/api/routines"], ["PATCH", "/api/routines/example"], ["DELETE", "/api/routines/example"],
  ["POST", "/api/calendar-calls"], ["PATCH", "/api/calendar-calls/example"], ["DELETE", "/api/calendar-calls/example"],
  ["POST", "/api/webhooks"], ["POST", "/api/webhooks/example/rotate"], ["POST", "/api/webhooks/example/test"],
  ["PATCH", "/api/webhooks/example"], ["DELETE", "/api/webhooks/example"],
  ["POST", "/api/connectors/example/authorize"], ["DELETE", "/api/connectors/example/accounts/account-a"], ["DELETE", "/api/connectors/example"],
  ["POST", "/api/bots/{bot}/connector-cards/example/authorize"],
];

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${fixture.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Each endpoint's status and relevant response fields are asserted at its
  // call site; this helper also carries deliberately rejected request shapes.
  return { status: response.status, body: await response.json() as Record<string, any> };
}

beforeAll(async () => {
  fixture = await launchVerificationServer();
  const proof = await api("GET", "/api/desktop-secret");
  expect(proof.status).toBe(200);
  expect(proof.body.secret).toBeTruthy();
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  const first = await api("POST", "/api/bots", { name: "Authority fixture A" }, desktop);
  const second = await api("POST", "/api/bots", { name: "Authority fixture B" }, desktop);
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  botId = first.body.bot.id;
  const group = await api("POST", "/api/groups", {
    name: "Authority fixture room", memberIds: [botId, second.body.bot.id],
    setup: { bulletin: "Fixture only", defaultResponder: { kind: "mentions" } },
  }, desktop);
  expect(group.status).toBe(201);
  groupId = group.body.group.id;
});

afterAll(async () => { await fixture?.close(); });

describe("desktop authority at the actual harness boundary", () => {
  it("refuses companion bot permission changes without writing the bot record", async () => {
    const before = readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8");
    const result = await api("PATCH", `/api/bots/${botId}`, { autoApprove: true, alwaysAllow: ["Bash:git"] }, { "x-murage-companion": "1" });
    expect(result).toMatchObject({ status: 404, body: { error: "no such route" } });
    expect(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).toBe(before);
  });

  it("refuses companion config changes without writing configuration", async () => {
    const before = readFileSync(join(fixture.info.dataDir, "config.json"), "utf8");
    const result = await api("PATCH", "/api/config", { features: { browser: false } }, { "x-murage-companion": "1" });
    expect(result).toMatchObject({ status: 404, body: { error: "no such route" } });
    expect(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).toBe(before);
  });

  it.each(administration)("denies %s %s before parsing or performing side effects", async (method, template) => {
    const path = template.replace("{bot}", botId).replace("{group}", groupId);
    // Malformed input proves the authority check runs before body validation.
    // The fixture has no provider credentials and an empty PATH; it cannot
    // accidentally provision a real host while exercising rejected routes.
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", ...remote }, body: "{",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no such route" });
  });

  it.each(["unmarked", "marker-only", "wrong-secret", "companion-with-secret"])("does not accept %s as desktop proof", async (kind) => {
    const headers: Record<string, string> = kind === "unmarked" ? {}
      : kind === "marker-only" ? { "x-murage-surface": "desktop" }
        : kind === "wrong-secret" ? { ...desktop, "x-murage-surface-secret": "incorrect" }
          : { ...desktop, ...remote };
    const before = readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8");
    const result = await api("PATCH", `/api/bots/${botId}?surface=desktop`, { autoApprove: true }, headers);
    expect(result.status).toBe(404);
    expect(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).toBe(before);
  });

  it("allows proven desktop authority updates and safe remote profiles", async () => {
    const bot = await api("PATCH", `/api/bots/${botId}`, { autoApprove: false, alwaysAllow: [] }, desktop);
    expect(bot.status).toBe(200);
    expect(bot.body.bot.autoApprove).toBe(false);
    const config = await api("PATCH", "/api/config", { features: { showToolCalls: true } }, desktop);
    expect(config.status).toBe(200);
    expect(config.body.features.showToolCalls).toBe(true);
    expect((await api("PATCH", `/api/groups/${groupId}`, { name: "Reviewed room" }, desktop)).status).toBe(200);
    const profile = await api("PATCH", `/api/bots/${botId}/profile`, { name: "Remote profile edit" }, remote);
    expect(profile.status).toBe(200);
    expect(profile.body.bot.name).toBe("Remote profile edit");
    expect(profile.body.bot.autoApprove).toBe(false);
  });

  it("preserves remote chat, tasks, room sends and content-bound single-use routine approval", async () => {
    const sent = await api("POST", `/api/bots/${botId}/messages`, { text: "Fixture authority chat" }, remote);
    expect(sent.status).toBe(202);
    await expect.poll(async () => {
      const bots = await api("GET", "/api/bots", undefined, desktop);
      return bots.body.bots.find((bot: { id: string }) => bot.id === botId)?.busy ?? false;
    }, { timeout: 10_000 }).toBe(false);
    rmSync(fixture.fixtureDumpPath, { force: true });
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "__fixture_hold_authority__" }, remote)).status).toBe(202);
    let dump: any;
    await expect.poll(() => {
      try { dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); return true; }
      catch { return false; }
    }, { timeout: 10_000 }).toBe(true);
    const token = dump.mcpConfig.mcpServers.agents.env.MURAGE_COMMS_TOKEN;
    const proposed = await api("POST", "/api/internal/routine-requests", {
      fromBotId: botId, fromThreadId: sent.body.threadId, action: "create",
      routine: { name: "Reviewed fixture routine", instructions: "Fixture only", schedule: { type: "weekly", time: "09:00", weekdays: ["monday"] } },
    }, { authorization: `Bearer ${token}` });
    expect(proposed.status).toBe(201);
    expect((await api("POST", `/api/bots/${botId}/interrupt`, undefined, remote)).status).toBe(200);
    const approved = await api("POST", `/api/threads/${sent.body.threadId}/respond`, { requestId: proposed.body.requestId, behavior: "allow" }, remote);
    expect(approved.status).toBe(200);
    expect((await api("GET", "/api/routines", undefined, desktop)).body.routines).toHaveLength(1);
    expect((await api("POST", `/api/threads/${sent.body.threadId}/respond`, { requestId: proposed.body.requestId, behavior: "allow" }, remote)).status).toBe(200);
    expect((await api("GET", "/api/routines", undefined, desktop)).body.routines).toHaveLength(1);
    expect((await api("POST", `/api/bots/${botId}/tasks`, { title: "Remote task" }, remote)).status).toBe(201);
    expect((await api("POST", `/api/groups/${groupId}/messages`, { text: "Fixture room authority chat" }, remote)).status).toBe(202);
  });
});

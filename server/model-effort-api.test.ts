// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// I4 (ACP-EFFORT): every entry that writes a model selection goes through the
// effort policy: create, override, thread override, duplicate, starter import and the MCP
// tool. A selection that carries both an effort level and a native choice is
// refused at each entry, and nothing is saved.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { starterProfileContents } from "./starter-profiles.ts";
import { handleToolCall } from "../scripts/mcp-server.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
let selection: { instanceId: string; model: string };

async function raw(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const both = () => ({ ...selection, effort: "low", variant: "native-a" });

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 18_799, span: 10_000 } });
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret?: unknown };
  if (typeof proof.secret !== "string") throw new Error("Missing fixture desktop proof");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const { body } = await raw("GET", "/api/instances");
  const engine = body.instances.find((instance: { instanceId: string }) => instance.instanceId === "verification");
  selection = { instanceId: "verification", model: engine.models.default };
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

describe("I4 effort policy at every selection entry", () => {
  it("API create refuses effort and a native choice together", async () => {
    const refused = await raw("POST", "/api/bots", { name: "Both", modelSelection: both() });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toMatch(/one|effort|thinking/i);
  });

  it("override refuses both fields and keeps the saved selection", async () => {
    const made = await raw("POST", "/api/bots", { name: "Override", modelSelection: selection });
    expect(made.status).toBeLessThan(300);
    const id = made.body.bot.id as string;
    const refused = await raw("PATCH", `/api/bots/${id}`, { modelSelection: both() });
    expect(refused.status).toBe(400);
    const after = await raw("GET", `/api/bots/${id}`);
    expect(after.body.bot.modelSelection.effort).toBeUndefined();
    expect(after.body.bot.modelSelection.variant).toBeUndefined();
  });

  it("thread override refuses both fields and keeps the saved selection", async () => {
    const made = await raw("POST", "/api/bots", { name: "Thread override", modelSelection: selection });
    expect(made.status).toBe(201);
    const { id, threadId } = made.body.bot;
    const refused = await raw("PATCH", `/api/bots/${id}/tasks/${threadId}`, {
      modelSelection: { instanceId: "fixture-offline", model: "fixture-model", effort: "low", variant: "native-a" },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/choose one effort setting/i);
    const after = await raw("GET", `/api/bots/${id}`);
    expect(after.status).toBe(200);
    expect(after.body.bot.modelSelection).toEqual(selection);
  });

  it("duplicate refuses a source selection with both fields before copying its profile", async () => {
    // The renderer's duplicateBot creates a blank bot, then patches its profile and selection together.
    const created = await raw("POST", "/api/bots");
    expect(created.status).toBe(201);
    const target = `/api/bots/${created.body.bot.id}`;
    const profile = { name: "Fixture copy", title: "Reviewer", description: "Reviews changes" };
    const effort = { instanceId: "fixture-offline", model: "fixture-model", effort: "low" };
    const refused = await raw("PATCH", target, { ...profile, modelSelection: { ...effort, variant: "native-a" } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/one effort setting/i);
    const unchanged = await raw("GET", target);
    expect(unchanged.status).toBe(200);
    for (const field of ["name", "title", "description", "modelSelection"]) {
      expect(unchanged.body.bot[field], field).toEqual(created.body.bot[field]);
    }

    const accepted = await raw("PATCH", target, { ...profile, modelSelection: effort });
    expect(accepted.status).toBe(200);
    const saved = await raw("GET", target);
    expect(saved.status).toBe(200);
    expect(saved.body.bot).toMatchObject(profile);
    expect(saved.body.bot.modelSelection).toEqual(effort);
  });

  it.each([{ effort: "low" }, { variant: "native-a" }])("route change clears the previous choice %j", async choice => {
    const previous = { instanceId: "fixture-offline", model: "fixture-model", ...choice };
    const created = await raw("POST", "/api/bots", { name: "Route fixture", modelSelection: previous });
    expect(created.status).toBe(201);
    expect(created.body.bot.modelSelection).toEqual(previous);
    const target = `/api/bots/${created.body.bot.id}`;
    expect((await raw("PATCH", target, { modelSelection: selection })).status).toBe(200);
    const saved = await raw("GET", target);
    expect(saved.status).toBe(200);
    expect(saved.body.bot.modelSelection).toEqual(selection);
  });

  it("starter import refuses both fields and accepts the same selection with one", async () => {
    const profileId = "starter-personal-home";
    const agents = starterProfileContents(profileId).manifest.definition.package.agents.map(agent => agent.key);
    const pick = { agents, skills: [], instructions: [], routines: [] };
    const reviewed = await raw("POST", "/api/starter-profiles", { profileId, action: "preview", selection: pick });
    expect(reviewed.status, JSON.stringify(reviewed.body).slice(0, 300)).toBe(200);
    const request = (modelSelection: unknown) => ({ profileId, action: "import", selection: pick, archiveSha256: reviewed.body.archiveSha256, reviewHash: reviewed.body.reviewHash, modelSelection });
    const refused = await raw("POST", "/api/starter-profiles", request(both()));
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toMatch(/one|effort|thinking/i);
    const control = await raw("POST", "/api/starter-profiles", request(selection));
    expect(control.status).not.toBe(400);
  });

  it("MCP set_bot_model and create_bot refuse both fields before any write", async () => {
    const calls: string[] = [];
    const fetcher = async (path: string, options?: RequestInit) => {
      if (options?.method && options.method !== "GET") calls.push(`${options.method} ${path}`);
      const response = await raw(options?.method ?? "GET", path, options?.body ? JSON.parse(String(options.body)) : undefined);
      if (response.status >= 400) throw new Error(String(response.body.error));
      return response.body;
    };
    const args = { instance_id: selection.instanceId, model: selection.model, effort: "low", variant: "native-a" };
    await expect(handleToolCall("create_bot", { name: "Mcp", ...args }, fetcher)).rejects.toThrow(/choose one effort setting/i);
    const made = await raw("POST", "/api/bots", { name: "McpTarget", modelSelection: selection });
    await expect(handleToolCall("set_bot_model", { bot_id: made.body.bot.id, ...args }, fetcher)).rejects.toThrow(/choose one effort setting/i);
    expect(calls).toEqual([]);
  });
});

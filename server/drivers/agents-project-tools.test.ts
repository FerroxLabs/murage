// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PROJECT_TOOL_ROLES } from "../project-tool-routing.ts";

const ECHO = "globalThis.fetch = async (url, init) => Response.json({ url, body: JSON.parse(init.body) });";
async function rpc(role: string, method = "tools/list", params = {}, fetchStub = ECHO) {
  const proxy = fileURLToPath(new URL("./agents-proxy.ts", import.meta.url));
  const script = `${fetchStub} await import(${JSON.stringify(proxy)});`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    env: { PATH: process.env.PATH, MURAGE_PROJECT_ROLE: role, MURAGE_HARNESS_URL: "http://127.0.0.1:1", MURAGE_BOT_ID: "fixture", MURAGE_THREAD_ID: "desk" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", error = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { error += chunk; });
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(error))); });
  return JSON.parse(output.trim());
}
async function list(role: string) {
  return (await rpc(role)).result.tools.filter((tool: { name: string }) => tool.name.startsWith("project_")) as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
}
it("lists all routed tools for the lead, member tools for members and none without an owner role", async () => {
  const lead = await list("lead"), member = await list("member");
  expect(lead.map(tool => tool.name).sort()).toEqual(Object.keys(PROJECT_TOOL_ROLES).map(name => `project_${name.replaceAll("-", "_")}`).sort());
  expect(member.map(tool => tool.name).sort()).toEqual(["project_bring_in", "project_card_update", "project_read_messages", "project_review_result", "project_suggest"]);
  expect(await list("")).toEqual([]);
  expect(await list("contact")).toEqual([]);
  expect(lead.find(tool => tool.name === "project_assign")?.inputSchema.properties).toHaveProperty("cards");
});

it("maps each exposed project tool to its registered route without a socket", async () => {
  const args = { card_id: "card", reviewer_bot_id: "rev", source_message_ids: ["source"], cards: [{ key: "a", assignee: "jax", title: "Work" }] };
  for (const route of Object.keys(PROJECT_TOOL_ROLES)) {
    const response = await rpc("lead", "tools/call", { name: `project_${route.replaceAll("-", "_")}`, arguments: args });
    const result = JSON.parse(response.result.content[0].text);
    expect(result.url).toBe(`http://127.0.0.1:1/api/internal/project/${route}`);
    if (route === "review-assign") expect(result.body).toEqual({ cardId: "card", reviewer: "rev" });
    // the server names what it does not expect, so the proxy forwards it all
    if (route === "assign") expect(result.body).toEqual(args);
  }
});

it("forwards a guessed single-card shape to the server so it can name what it expects", async () => {
  const guessed = { assignee: "Reed", task: "Research segments", due: "2026-09-30", priority: "high" };
  const response = await rpc("lead", "tools/call", { name: "project_assign", arguments: guessed });
  expect(JSON.parse(response.result.content[0].text).body).toEqual(guessed);
});

// The AFTER-PF run: every refused project_assign read "HTTP 409" to the lead.
const refusing = (status: number, body: unknown) =>
  `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status}, headers: { "content-type": "application/json" } });`;
it.each([
  ["project_assign", 409, { ok: false, status: "assign", refused: [{ key: "segments", reason: "Reed is not a member of this project" }] }, ["segments", "Reed is not a member of this project"]],
  ["project_assign", 400, { error: "project_assign takes cards: [{ key, assignee, title, description }]. Unknown fields: task, due." }, ["Unknown fields: task, due."]],
  ["project_done", 409, { error: "not_allowed", reason: "The goal is not finished yet.", blockers: ["k1 is not met", "card 2 is in review"] }, ["The goal is not finished yet.", "k1 is not met", "card 2 is in review"]],
  ["project_review_assign", 409, { ok: false, reason: "Card 3 is not waiting for review." }, ["Card 3 is not waiting for review."]],
  ["project_accept", 409, { error: "not_allowed", reason: "The latest review of card 3 did not pass." }, ["The latest review of card 3 did not pass."]],
] as const)("hands %s's refusal to the model in words, never a bare HTTP code (%i)", async (tool, status, body, expected) => {
  const args = { cards: [{ key: "segments", assignee: "Reed", title: "Segments" }], card_id: "c3", reviewer_bot_id: "rev" };
  const response = await rpc("lead", "tools/call", { name: tool, arguments: args }, refusing(status, body));
  const text = response.result.content[0].text as string;
  expect(response.result.isError).toBe(true);
  expect(text).not.toMatch(/HTTP \d{3}/);
  expect(text).not.toContain("not_allowed");
  for (const part of expected) expect(text).toContain(part);
});

it("R6 a proposal turn lists only project_propose, and no other role lists it", async () => {
  const tools = (await rpc("proposal")).result.tools as Array<{ name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }>;
  expect(tools.map(tool => tool.name)).toEqual(["project_propose"]);
  expect(Object.keys(tools[0]!.inputSchema.properties).sort()).toEqual(["brief", "budget", "leadBotId", "members", "mode", "planOutline"]);
  for (const role of ["lead", "member", ""]) expect((await rpc(role)).result.tools.map((tool: { name: string }) => tool.name)).not.toContain("project_propose");
  for (const name of ["list_bots", "ask_bot", "delegate_bot", "create_bot", "murage_help", "project_assign"])
    expect((await rpc("proposal", "tools/call", { name, arguments: {} })).error.message).toBe(`Unknown tool: ${name}`);
});

it("R6 project_propose posts the proposal to its internal route; a missing lead is sent as no lead", async () => {
  const args = { members: ["a"], mode: "bots", brief: { summary: "s", doneMeans: "d", rules: "r" }, budget: { minutes: 120, tokens: 3000000 }, planOutline: ["x"] };
  const response = await rpc("proposal", "tools/call", { name: "project_propose", arguments: args });
  const result = JSON.parse(response.result.content[0].text);
  expect(result.url).toBe("http://127.0.0.1:1/api/internal/project/propose");
  expect(result.body).toEqual({ ...args, leadBotId: null });
});

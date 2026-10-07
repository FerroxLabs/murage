// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Import from Hermes, end to end against the real harness (0.1.61 L4, C2/H2).
// The fixture's HERMES_HOME is a temp root with `default` and one named
// profile; nothing starts the Hermes CLI (the child's PATH is empty).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = headers) {
  const response = await fetch(fixture.info.url + path, {
    method,
    headers: { ...extra, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { portRange: { from: 18_799, span: 10_000 } });
  const root = join(fixture.info.dataDir, ".hermes");
  mkdirSync(join(root, "profiles", "fred", "skills", "notes"), { recursive: true });
  writeFileSync(join(root, "config.yaml"), "model:\n  default: base-model\n  provider: custom\n");
  writeFileSync(join(root, "profiles", "fred", "config.yaml"), "model:\n  default: fred-model\n  provider: custom\n");
  writeFileSync(join(root, "profiles", "fred", "SOUL.md"), "# Fred\n\nFred keeps the books. He is careful.\n");
  writeFileSync(join(root, "profiles", "fred", "skills", "notes", "SKILL.md"), "---\nname: notes\n---\n");
  await fixture.restart();
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret?: unknown };
  if (typeof proof.secret !== "string") throw new Error("Missing fixture desktop proof");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

describe("Import from Hermes", () => {
  it("is desktop only", async () => {
    expect((await call("GET", "/api/hermes/profiles", undefined, {})).status).toBe(404);
    expect((await call("POST", "/api/hermes/profiles/import", { profiles: ["fred"] }, {})).status).toBe(404);
  });

  it("lists the profiles from the filesystem", async () => {
    const { status, body } = await call("GET", "/api/hermes/profiles");
    expect(status).toBe(200);
    expect(body.found).toBe(true);
    const fred = body.profiles.find((profile: { name: string }) => profile.name === "fred");
    expect(fred).toMatchObject({ label: "fred", description: "Fred keeps the books.", model: "fred-model", skillCount: 1, hasSoul: true, importedAs: null });
    expect(body.profiles.map((profile: { name: string }) => profile.name)).toEqual(["default", "fred"]);
  });

  it("creates one bot on its own profile engine, and a second import skips it", async () => {
    const first = await call("POST", "/api/hermes/profiles/import", { profiles: ["fred", "nobody", "../x"] });
    expect(first.status).toBe(200);
    expect(first.body.created).toHaveLength(1);
    expect(first.body.created[0]).toMatchObject({ profile: "fred", name: "fred" });
    expect(first.body.skipped).toEqual(expect.arrayContaining([
      { profile: "nobody", reason: "not-found" },
      { profile: "../x", reason: "invalid" },
    ]));
    const config = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    const instanceId = first.body.created[0].instanceId as string;
    // Every route and the restore gate take ids of [\w-] (audit, Astra 1/5).
    expect(instanceId).toMatch(/^[\w-]{1,160}$/);
    expect(config.instances[instanceId]).toMatchObject({ driver: "hermesAgent", config: { profile: "fred" } });
    const { body: listed } = await call("GET", "/api/bots");
    const bot = listed.bots.find((candidate: { id: string }) => candidate.id === first.body.created[0].botId);
    expect(bot.modelSelection.instanceId).toBe(instanceId);
    // Settings can turn the imported engine off and on like any other.
    expect((await call("PATCH", `/api/instances/${encodeURIComponent(instanceId)}`, { enabled: false })).status).toBe(200);
    expect((await call("PATCH", `/api/instances/${encodeURIComponent(instanceId)}`, { enabled: true })).status).toBe(200);
    expect(bot.description).toBe("Fred keeps the books.");

    const again = await call("POST", "/api/hermes/profiles/import", { profiles: ["fred"] });
    expect(again.body.created).toEqual([]);
    expect(again.body.skipped).toEqual([{ profile: "fred", reason: "already-imported", botName: "fred" }]);
    const { body: after } = await call("GET", "/api/hermes/profiles");
    expect(after.profiles.find((profile: { name: string }) => profile.name === "fred").importedAs).toBe("fred");
  });

  it("refuses a body that is not a list of profiles", async () => {
    expect((await call("POST", "/api/hermes/profiles/import", { profiles: [] })).status).toBe(400);
    expect((await call("POST", "/api/hermes/profiles/import", { profiles: ["fred"], extra: 1 })).status).toBe(400);
  });
});

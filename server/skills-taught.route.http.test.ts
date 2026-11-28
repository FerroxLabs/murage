// W9 over HTTP (TEACH-ENTRY 1.0.23 D6): GET/PATCH /api/skills/taught on a booted server. The desktop app
// lists and changes a recording; a request without the desktop proof gets 404 before any file is read;
// `taught` is never read as a skill id by the generic /api/skills/:ref handler.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string> = {};
const api = async (method: string, path: string, body?: unknown, proof = true) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...(proof ? headers : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as any };
};
const manifestPath = () => join(fixture.info.dataDir, "skills", "file-receipts", "manifest.json");

beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, {});
  const proof = await api("GET", "/api/desktop-secret", undefined, false);
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
  const dir = join(fixture.info.dataDir, "skills", "file-receipts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify({ id: "file-receipts", name: "File receipts", version: "1.0.0", description: "Files receipts.", defaultEnabled: true, triggerTerms: ["receipts"], requiredCapabilities: [], audience: "owner" }));
  writeFileSync(join(dir, "SKILL.md"), "---\nname: file-receipts\ndescription: Files receipts.\n---\nSteps.\n");
}, 120_000);
afterAll(async () => { await fixture?.close(); });

describe("W9 Taught by you over HTTP", () => {
  it("GET lists the recording (not read as a skill id); PATCH to a real bot writes bots; an unknown bot is 400", async () => {
    const listed = await api("GET", "/api/skills/taught");
    expect(listed.status).toBe(200);
    expect(listed.body.skills).toEqual([expect.objectContaining({ id: "file-receipts", name: "File receipts" })]);
    const instance = (await api("GET", "/api/instances")).body.instances.find((item: any) => item.instanceId === "verification");
    const bot = (await api("POST", "/api/bots", { name: "Dax", modelSelection: { instanceId: "verification", model: instance.models.options[0].id } })).body.bot;
    const patched = await api("PATCH", "/api/skills/taught/file-receipts", { bots: [bot.id] });
    expect(patched.status).toBe(200);
    expect(JSON.parse(readFileSync(manifestPath(), "utf8")).bots).toEqual([bot.id]);
    const refused = await api("PATCH", "/api/skills/taught/file-receipts", { bots: ["nobody"] });
    expect(refused.status).toBe(400);
    expect(JSON.parse(readFileSync(manifestPath(), "utf8")).bots).toEqual([bot.id]);
  }, 60_000);

  it("without the desktop proof both routes are 404", async () => {
    expect((await api("GET", "/api/skills/taught", undefined, false)).status).toBe(404);
    expect((await api("PATCH", "/api/skills/taught/file-receipts", { bots: null }, false)).status).toBe(404);
  }, 30_000);
});

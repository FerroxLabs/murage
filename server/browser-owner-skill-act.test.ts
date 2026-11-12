// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DESIGN 3.2 Foreign code on the REAL handler (handleSkillsApi) with the REAL gate (ownerCodeGate): the code an owner's browser gives to switch a
// collection skill on binds the scanned content hash, so the skill that was reviewed is the skill that goes on, and a swapped one is refused.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { removeTempDirSync } from "./testing/cleanup.ts";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { ownerCodeGate, setBrowserOwnerAct } from "./browser-owner-gates.ts";
import type { CloudOwnerAct } from "./cloud-request-auth.ts";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import { skillActDigest } from "./cloud-home/owner-code.ts";
import type { CloudDevice } from "./cloud-sessions.ts";

const dataDir = mkdtempSync(join(tmpdir(), "murage-skill-act-"));
let handle: typeof import("./skills-api.ts").handleSkillsApi;
const pem = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
const owner = (): CloudDevice & { accessHash: string } => ({ id: "dev-1", account: "owner", scope: "browser", publicKey: pem(), assertionKey: pem(), revoked: 0, factor: "remembered-owner", accessHash: "hash-1" });
/** A code service that accepts a proof of the form `ok:<act>` once and mints `tok:<label>:<act>` tokens. */
function service(): CloudOwnerAct {
  const spent = new Set<string>();
  return { token: (input) => `tok:${input.label}:${input.act}`, doorFresh: () => false,
    verifyProof: (req, _device, act) => { const ok = req.headers["x-murage-owner-proof"] === `ok:${act}` && !spent.has(act); if (ok) spent.add(act); return ok; } };
}
const request = (proof?: string): IncomingMessage => {
  const headers = { ...(proof ? { "x-murage-owner-proof": proof } : {}) } as IncomingMessage["headers"];
  setCloudIdentity(headers, owner());
  return { headers } as IncomingMessage;
};
const bots = () => [{ id: "b1", name: "Sable", canUseSkills: true }];
const md = (body: string) => `---\nname: swap-me\ndescription: swap-me test skill.\n---\n${body}\n`;
const usedOn = async () => ((await call("GET", "/api/skills/collection:swap-me", undefined))!.body as { bots: Array<{ enabled: boolean }> }).bots.some((bot) => bot.enabled);
const ROUTE = "route-act-1";
async function call(method: string, path: string, body: unknown, req?: IncomingMessage, routeAct = ROUTE) {
  return handle({ method, path, url: new URL(path, "http://home.test"), readBody: async () => body, bots,
    ...(req ? { routeAct, ownerCode: (act: string) => ownerCodeGate(req, act, "new_skill") } : {}) });
}
const importSkill = (body: string, replace = false) => call("POST", "/api/skills/import", { files: [{ path: "swap-me/SKILL.md", content: md(body) }], kind: "folder", replace });
const hashOf = async () => ((await call("GET", "/api/skills/collection:swap-me", undefined))!.body as { scan: { contentHash: string } }).scan.contentHash;

beforeAll(async () => {
  vi.stubEnv("MURAGE_DATA_DIR", dataDir);
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  ({ handleSkillsApi: handle } = await import("./skills-api.ts"));
  setBrowserOwnerAct(service());
});
afterAll(() => { setBrowserOwnerAct(undefined); vi.unstubAllEnvs(); removeTempDirSync(dataDir); });

describe("collection skill switch-on from an owner's browser", () => {
  test("the 403 carries a token for the route act bound to the content hash, and nothing is installed", async () => {
    expect((await importSkill("Draft polite reminders."))!.status).toBe(201);
    const hash = await hashOf();
    const refused = await call("PUT", "/api/skills/collection:swap-me/bots/b1", { on: true }, request());
    expect(refused).toMatchObject({ status: 403, body: { code: "email_code", label: "new_skill", actToken: `tok:new_skill:${skillActDigest(ROUTE, hash)}` } });
    expect(await usedOn()).toBe(false);
  });
  test("a proof for the act bound to the same content switches it on", async () => {
    const hash = await hashOf();
    const on = await call("PUT", "/api/skills/collection:swap-me/bots/b1", { on: true }, request(`ok:${skillActDigest(ROUTE, hash)}`));
    expect(on!.status).toBe(200);
    expect(on!.body).toMatchObject({ skill: { name: "swap-me", enabled: true } });
    await call("PUT", "/api/skills/collection:swap-me/bots/b1", { on: false });
  });
  test("a proof for the route act alone, without the content hash, is refused", async () => {
    const refused = await call("PUT", "/api/skills/collection:swap-me/bots/b1", { on: true }, request(`ok:${ROUTE}`));
    expect(refused).toMatchObject({ status: 403, body: { code: "fresh_auth_changed" } });
  });
  test("the skill changed between the code and the retry: the proof for the old hash is refused and nothing goes on", async () => {
    const before = await hashOf();
    const proof = `ok:${skillActDigest(ROUTE, before)}`;
    expect((await importSkill("Something else entirely, swapped after the owner looked.", true))!.status).toBe(201);
    expect(await hashOf()).not.toBe(before);
    const refused = await call("PUT", "/api/skills/collection:swap-me/bots/b1", { on: true }, request(proof));
    expect(refused).toMatchObject({ status: 403, body: { code: "fresh_auth_changed" } });
    expect(await usedOn()).toBe(false);
  });
  test("off and the desktop path (no gate) are unchanged", async () => {
    const on = await call("PUT", "/api/skills/collection:swap-me/bots/b1", { on: true });
    expect(on!.status).toBe(200);
    const off = await call("PUT", "/api/skills/collection:swap-me/bots/b1", { on: false }, request());
    expect(off!.status).toBe(200);
  });
});

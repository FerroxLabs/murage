// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Terms acceptance record: the version, time and app version are written to
// the data folder, survive a restart (a fresh read of the same folder), and a
// newer TERMS_VERSION asks again. Pure file work in a temp folder.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TERMS_VERSION } from "../shared/terms.ts";
import { handleTermsApi, readTermsRecords, recordTermsAcceptance, termsStatus } from "./terms.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "murage-terms-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const post = (body: unknown, env: NodeJS.ProcessEnv = {}) => handleTermsApi({ method: "POST", path: "/api/terms/accept", readBody: async () => body }, dir, env);
const get = (env: NodeJS.ProcessEnv = {}) => handleTermsApi({ method: "GET", path: "/api/terms", readBody: async () => ({}) }, dir, env);

describe("terms acceptance record", () => {
  it("is not accepted on a fresh data folder (first run)", () => {
    expect(termsStatus(dir, {})).toEqual({ version: TERMS_VERSION, accepted: false });
  });

  it("records version, time and app version, owner-only, and survives a restart", () => {
    const at = new Date("2026-10-11T09:30:00.000Z");
    recordTermsAcceptance({ appVersion: "1.0.2" }, dir, () => at);
    // a restart is a new process reading the same folder
    expect(readTermsRecords(dir)).toEqual([{ version: TERMS_VERSION, acceptedAt: at.toISOString(), appVersion: "1.0.2" }]);
    expect(termsStatus(dir, {})).toMatchObject({ accepted: true, acceptedVersion: TERMS_VERSION, acceptedAt: at.toISOString(), source: "record" });
    if (process.platform !== "win32") expect(statSync(join(dir, "terms-acceptance.json")).mode & 0o777).toBe(0o600);
  });

  it("asks again, once, when the terms version moves on (upgrade re-prompt)", () => {
    writeFileSync(join(dir, "terms-acceptance.json"), JSON.stringify({ accepted: [{ version: "2025-01-01", acceptedAt: "2025-01-02T00:00:00.000Z" }] }));
    expect(termsStatus(dir, {})).toEqual({ version: TERMS_VERSION, accepted: false, acceptedVersion: "2025-01-01", acceptedAt: "2025-01-02T00:00:00.000Z" });
    recordTermsAcceptance({}, dir);
    expect(termsStatus(dir, {}).accepted).toBe(true);
    // the earlier acceptance stays on record
    expect(readTermsRecords(dir).map((entry) => entry.version)).toEqual(["2025-01-01", TERMS_VERSION]);
  });

  it("reads a damaged file as not accepted", () => {
    writeFileSync(join(dir, "terms-acceptance.json"), "{not json");
    expect(termsStatus(dir, {}).accepted).toBe(false);
  });

  it("MURAGE_TERMS_ACCEPTED counts only when it names the current version, and writes nothing", () => {
    expect(termsStatus(dir, { MURAGE_TERMS_ACCEPTED: TERMS_VERSION })).toEqual({ version: TERMS_VERSION, accepted: true, source: "environment" });
    expect(termsStatus(dir, { MURAGE_TERMS_ACCEPTED: "1" }).accepted).toBe(false);
    expect(termsStatus(dir, { MURAGE_TERMS_ACCEPTED: "2020-01-01" }).accepted).toBe(false);
    expect(() => readFileSync(join(dir, "terms-acceptance.json"))).toThrow();
  });
});

describe("terms routes", () => {
  it("GET answers the status; POST records it and the next GET agrees", async () => {
    expect((await get())?.body).toMatchObject({ accepted: false });
    const accepted = await post({ version: TERMS_VERSION, ageConfirmed: true, appVersion: "1.0.2" });
    expect(accepted?.status).toBe(200);
    expect((await get())?.body).toMatchObject({ accepted: true });
    expect(readTermsRecords(dir)[0]).toMatchObject({ version: TERMS_VERSION, appVersion: "1.0.2" });
  });

  it("refuses without the age and agreement confirmation", async () => {
    expect((await post({ version: TERMS_VERSION }))?.status).toBe(400);
    expect((await post({ version: TERMS_VERSION, ageConfirmed: false }))?.status).toBe(400);
    expect(termsStatus(dir, {}).accepted).toBe(false);
  });

  it("refuses a screen that showed an older version", async () => {
    const answer = await post({ version: "2025-01-01", ageConfirmed: true });
    expect(answer?.status).toBe(409);
    expect(termsStatus(dir, {}).accepted).toBe(false);
  });

  it("refuses unknown fields, a bad app version, bad bodies and other methods", async () => {
    expect((await post({ version: TERMS_VERSION, ageConfirmed: true, extra: 1 }))?.status).toBe(400);
    expect((await post({ version: TERMS_VERSION, ageConfirmed: true, appVersion: "../../x" }))?.status).toBe(400);
    expect((await post([]))?.status).toBe(400);
    expect((await handleTermsApi({ method: "PUT", path: "/api/terms", readBody: async () => ({}) }, dir))?.status).toBe(405);
    expect(await handleTermsApi({ method: "GET", path: "/api/other", readBody: async () => ({}) }, dir)).toBeNull();
  });
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Row 84 (code-only delete): native HighLevel leaves no desktop notice. An install that still holds the old stored
// HighLevel folder gets no "moved" line from the real route, and the stored files are left exactly as they were.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;
const get = async (path: string) => {
  const response = await fetch(`${fixture.info.url}${path}`, { headers });
  return { status: response.status, text: await response.text() };
};

describe.skipIf(process.platform === "win32")("native HighLevel is gone", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { whatsNew: "pending" });
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("an install with the old stored HighLevel folder gets no moved line and its files stay untouched", async () => {
    const dir = join(fixture.info.dataDir, "highlevel");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "connection.json");
    const stored = JSON.stringify({ locationName: "fixture location" });
    writeFileSync(file, stored);
    // Start the server again over the stored folder, as an update from the old build does.
    await fixture.restart();
    const secret = (await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string }).secret;
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
    const answers = [await get("/api/notices/highlevel-moved"), await get("/api/notices/highlevel-moved")];
    expect(readFileSync(file, "utf8")).toBe(stored);
    expect(readdirSync(dir)).toEqual(["connection.json"]);
    expect(readdirSync(fixture.info.dataDir)).not.toContain("highlevel-moved-notice.json");
    for (const answer of answers) {
      expect(answer.text).not.toContain("HighLevel now connects");
      expect(answer.status, answer.text).toBe(404);
    }
  });
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The set-up check through the real server and a stand-in Claude CLI: desktop only, a strict body, the exact answer shape, and one
// fixed prompt on a one-shot that touches no thread.
import { removeTempDir } from "./testing/cleanup.ts";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { ENGINE_REPLY_PROMPT } from "./drivers/cli-memory-learning.ts";

let fixture: VerificationServer;
let headers: Record<string, string> = {};
const scratch = mkdtempSync(join(tmpdir(), "setup-check-api-"));
const seen = join(scratch, "stdin.txt");

// The stand-in is a Node CLI on every OS. Its stdin is the exact prompt under test.
const standIn = (name: string, result: string, isError: boolean) => {
  const file = join(scratch, `${name}.cjs`);
  const frame = JSON.stringify({ type: "result", result, is_error: isError });
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.316 (Claude Code)'); process.exit(0); }
if (process.argv[2] === 'auth') { console.log('{"loggedIn":true}'); process.exit(0); }
process.stdin.on('data', bytes => fs.appendFileSync(${JSON.stringify(seen)}, bytes));
process.stdin.on('end', () => {
  console.log('{"type":"system","subtype":"init"}');
  console.log(${JSON.stringify(frame)});
  process.exitCode = ${isError ? 1 : 0};
});
`, { mode: 0o755 });
  return `"${process.execPath}" "${file}"`;
};
const instances = {
  good: standIn("claude-good", "ready", false),
  signedOut: standIn("claude-out", "Not logged in · Please run /login", true),
  limited: standIn("claude-limit", "You've hit your session limit · resets 3pm", true),
  refused: standIn("claude-refused", "Blocked by your organization's policy", true),
};

const post = async (body: unknown, proven = true, type = "application/json") => {
  const response = await fetch(`${fixture.info.url}/api/engine-setup-check`, { method: "POST", headers: { "content-type": type, ...(proven ? headers : {}) }, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

describe("POST /api/engine-setup-check, real server", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs');const path=await import('node:path');
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      for(const [id,cli] of Object.entries(${JSON.stringify(instances)}))cfg.instances[id]={driver:'claudeAgent',displayName:'Claude Code',config:{cli}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  });
  afterAll(async () => { await fixture?.close(); await removeTempDir(scratch); });

  it("answers the desktop alone, takes a strict body and JSON only", async () => {
    expect((await post({ instanceId: "good" }, false)).status).not.toBe(200);
    expect((await post({ instanceId: "good", extra: 1 })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ instanceId: "nobody" })).status).toBe(404);
    expect((await post({ instanceId: "good" }, true, "text/plain")).status).toBe(415);
    expect(existsSync(seen)).toBe(false);
  });
  it("runs one reply with the fixed prompt and adds no thread", async () => {
    const before = await (await fetch(`${fixture.info.url}/api/bots`, { headers })).text();
    expect((await post({ instanceId: "good" })).body).toEqual({ result: "ready" });
    expect(readFileSync(seen, "utf8")).toContain(ENGINE_REPLY_PROMPT);
    expect(readFileSync(seen, "utf8").length).toBe(ENGINE_REPLY_PROMPT.length);
    expect(await (await fetch(`${fixture.info.url}/api/bots`, { headers })).text()).toBe(before);
  });
  it("maps a lost login, a plan limit and a policy refusal", async () => {
    expect((await post({ instanceId: "signedOut" })).body).toEqual({ result: "signin" });
    expect((await post({ instanceId: "limited" })).body).toEqual({ result: "limit", line: "You've hit your session limit · resets 3pm" });
    expect((await post({ instanceId: "refused" })).body).toEqual({ result: "refused", line: "Blocked by your organization's policy" });
  });
});

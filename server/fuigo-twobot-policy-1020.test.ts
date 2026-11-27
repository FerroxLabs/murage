// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: Fuigo launch policy (drivers/acp/fuigo-policy.ts ensureFuigoPolicy). Consumer: the ACP core's Fuigo launch.
// FUIGO2BOT (1.0.20 field report): two bots on the Fuigo engine with the SAME model run at the same time and the second
// one errors on a Fuigo file. Real server, one fuigoAgent instance, two bots pinned to the same model, the fake engine
// holding the launch policy open for its life as Fuigo 1.0.36+ does (FAKE_ACP_POLICY_PIN), and reporting its MCP servers
// ready (so the separate 1.0.20 MCP-gate refusal, core.ts:7484-7490, is not what this proves). Bot A's turn is held open at
// its gate; bot B then sends. The server runs under the Windows replace rule (windows-replace-rule.mjs: a rename onto a
// file another process holds open is refused, judged from real open handles), so this is the Windows field shape.
// v1.0.20: bot B's launch renames a fresh policy over A's pinned file and the turn ends with
// "EPERM: operation not permitted, rename ... fuigo-policy/launch-*.toml"; fixed: both bots answer.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const RULE = join(SERVER_DIR, "testing", "windows-replace-rule.mjs");
const posixOnly = describe.skipIf(process.platform === "win32"); // the fake engine is a shebang script (same as fuigo-steer-api.test.ts)
const MODEL = "fake-acp-model";

let base: string;
let headers: Record<string, string>;
let child: ChildProcess;
let home: string;
let stderr = "";

const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const messages = async (threadId: string) => (await request("GET", `/api/threads/${threadId}/messages?limit=200`)).body.messages as any[];
const busy = async (botId: string) => (await request("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy;
/** Engine sessions opened under the verified policy (the fake appends one line per checked session/new or load). */
const policySessions = () => { const file = join(home, "fuigo-dump.json.policy.jsonl"); return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0; };

posixOnly("FUIGO2BOT: two bots, same Fuigo model, overlapping turns (fake engine pins the policy, Windows replace rule)", () => {
  beforeAll(async () => {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-fuigo2bot-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    mkdirSync(join(home, ".fuigo"), { recursive: true });
    writeFileSync(join(home, ".fuigo", "auth.json"), "{}");
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: { fuigo: {
      driver: "fuigoAgent",
      environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_GATE_FILE: join(home, "fuigo.gate"), FAKE_ACP_DUMP: join(home, "fuigo-dump.json"), FAKE_ACP_POLICY_PIN: "1", FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_LIST: "all:ready" },
      config: { cli: FAKE_ACP, fullAuto: false },
    } } }));
    child = spawn(process.execPath, ["--import", RULE, join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home, USERPROFILE: home,
        MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
        MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_MODEL_PROVIDER_CONNECTIONS: "", MURAGE_MODEL_PROVIDER_COMMIT_TOKEN: "",
        MURAGE_TEST_WINDOWS_REPLACE_RULE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    child.stdout!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
    const proof = (await fetch(`${base}/api/desktop-secret`).then((r) => r.json())) as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 40_000);

  afterAll(async () => {
    writeFileSync(join(home, "fuigo.gate"), "go");
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  const bot = async (name: string) => {
    const created = await request("POST", "/api/bots", { name, modelSelection: { instanceId: "fuigo", model: MODEL } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const made = created.body.bot as { id: string; threadId: string };
    expect((await request("PATCH", `/api/bots/${made.id}`, { autoApprove: true, autoReview: "off", computer: "off", browser: false, composio: false })).status).toBe(200);
    return made;
  };

  it("the second bot's turn starts and answers while the first bot's Fuigo is running", async () => {
    const a = await bot("Fixture bot A");
    const b = await bot("Fixture bot B");
    expect((await request("POST", `/api/bots/${a.id}/messages`, { threadId: a.threadId, text: "Fixture question A" })).status).toBe(202);
    await expect.poll(policySessions, { timeout: 30_000 }).toBe(1); // A's engine is up, its policy verified and pinned
    expect(await busy(a.id)).toBe(true);

    expect((await request("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text: "Fixture question B" })).status).toBe(202);
    // B either reaches its own engine (a second verified session) or its turn ends first (the v1.0.20 failure).
    await expect.poll(async () => policySessions() >= 2 || !(await busy(b.id)), { timeout: 30_000 }).toBe(true);
    writeFileSync(join(home, "fuigo.gate"), "go");
    await expect.poll(async () => !(await busy(a.id)) && !(await busy(b.id)), { timeout: 30_000 }).toBe(true);

    const rowsB = await messages(b.threadId);
    const textB = JSON.stringify(rowsB);
    console.log(`FUIGO2BOT sessions=${policySessions()} B=${textB.slice(0, 3000)}\nserver: ${stderr.split("\n").filter((l) => /EPERM|fuigo-policy|mcp|refus|not-built|\[acp\]|fence/i.test(l)).slice(0, 40).join("\n")}`);
    expect(textB).not.toMatch(/EPERM|EACCES|EBUSY|fuigo-policy|operation not permitted/);
    expect(rowsB.some((m) => m.role === "bot" && String(m.text ?? "").includes("Fixture question B"))).toBe(true);
    expect((await messages(a.threadId)).some((m) => m.role === "bot" && String(m.text ?? "").includes("Fixture question A"))).toBe(true);
    expect(policySessions()).toBe(2);
  }, 120_000);
});

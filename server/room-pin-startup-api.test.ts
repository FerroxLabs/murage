// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VerificationServer } from "../scripts/control-murage.ts";
import { OWNER_PIN_INDEX } from "./memory/schema.ts";
import { launchMemoryVerificationServer } from "./testing/memory-verification-fixture.ts";
import { POWER_BLOCK_UNWRAP_SOURCE } from "./testing/power-block-test.ts";

type Message = { role: string; kind: string; text?: string; from?: { botId: string }; tool?: { ok: boolean; name: string } };
type Instance = { instanceId: string; models: { options: { id: string }[] } };
type Group = { id: string; threadId: string; working: boolean; busyBotId: string | null };

describe.skipIf(process.platform === "win32")("a fresh room in a closed background admission window", () => {
  let server: VerificationServer, secret: string, group: Group, responder: string, db: DatabaseSync;
  const api = async <T = unknown>(method: string, path: string, status: number, body?: unknown) => {
    const response = await fetch(server.info.url + path, { method, headers: {
      "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret,
    }, body: JSON.stringify(body) });
    expect(response.status, path).toBe(status);
    return await response.json() as T;
  };
  beforeAll(async () => {
    server = await launchMemoryVerificationServer(process.env, undefined, { instrumentationSource: `${POWER_BLOCK_UNWRAP_SOURCE}
      await import(${JSON.stringify(new URL("./testing/idle-load-preload.mjs", import.meta.url).href)});
      await import(${JSON.stringify(new URL("./testing/fake-engine-env-preload.mjs", import.meta.url).href)});
      const { ioBudget, readAdmissionProcess } = await import(${JSON.stringify(new URL("./io-budget.ts", import.meta.url).href)});
      // Hold only the admission sample in the last five seconds. SQLite, the room and the engine use real time.
      Reflect.set(ioBudget, "admissionRead", () => {
        const sample = readAdmissionProcess();
        return { ...sample, at: Math.floor(sample.at / 60000) * 60000 + 57000 };
      });
      const fs = await import("node:fs"), path = await import("node:path");
      const { LineageAllowance } = await import(${JSON.stringify(new URL("./memory/lineage-allowance.ts", import.meta.url).href)});
      const roomAllowance = LineageAllowance.room.bind(LineageAllowance);
      const fault = path.join(process.env.MURAGE_DATA_DIR, "fail-room-entry");
      LineageAllowance.room = (...args) => {
        if (fs.existsSync(fault)) {
          fs.unlinkSync(fault);
          throw new Error("fixture setup read failed");
        }
        return roomAllowance(...args);
      };
      const file = path.join(process.env.MURAGE_DATA_DIR, "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.instances.roomFixture = { driver: "piAgent", displayName: "Room fixture",
        config: { cli: ${JSON.stringify(fileURLToPath(new URL("./testing/fake-pi-cli.ts", import.meta.url)))}, fullAuto: true },
        environment: { FAKE_PI_DUMP: path.join(process.env.MURAGE_DATA_DIR, "engine.jsonl") } };
      fs.writeFileSync(file, JSON.stringify(config));
    ` });
    const bootstrap = await fetch(server.info.url + "/api/desktop-secret");
    expect(bootstrap.status).toBe(200);
    secret = (await bootstrap.json() as { secret: string }).secret;
    expect((await api<{ mode: string }>("GET", "/api/memory/status", 200)).mode).toBe("active");
    const instances = (await api<{ instances: Instance[] }>("GET", "/api/instances", 200)).instances;
    const model = instances.find(instance => instance.instanceId === "roomFixture")!.models.options[0]!.id;
    const members: string[] = [];
    for (const name of ["Alpha", "Bravo"]) {
      const { bot } = await api<{ bot: { id: string } }>("POST", "/api/bots", 201, { name, modelSelection: { instanceId: "roomFixture", model } });
      await api("PATCH", `/api/bots/${bot.id}`, 200, { computer: "off", browser: false, composio: false });
      members.push(bot.id);
    }
    responder = members[0]!;
    group = (await api<{ group: Group }>("POST", "/api/groups", 201, { name: "Garden", memberIds: members,
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: responder } } })).group;
    db = new DatabaseSync(join(server.info.dataDir, "messages.db"));
    db.exec("PRAGMA busy_timeout=5000");
  }, 60000);
  afterAll(async () => { db?.close(); await server?.close(); });

  const prompts = () => {
    const file = join(server.info.dataDir, "engine.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(line => line && JSON.parse(line).prompt).length : 0;
  };
  const send = async (text: string) => {
    await api("POST", `/api/groups/${group.id}/messages`, 202, { text });
    const rows = async () => {
      const { messages } = await api<{ messages: Message[] }>("GET", `/api/threads/${group.threadId}/messages?limit=100`, 200);
      const ask = messages.findIndex(row => row.role === "user" && row.text === text);
      expect(ask).toBeGreaterThanOrEqual(0);
      return messages.slice(ask + 1).filter(row => row.role === "bot" && (row.kind === "text" || row.tool?.ok === false));
    };
    await expect.poll(async () => {
      const { groups } = await api<{ groups: Group[] }>("GET", "/api/bots?messages=0", 200);
      const current = groups.find(item => item.id === group.id)!;
      return !current.working && !current.busyBotId;
    }, { timeout: 20000 }).toBe(true);
    return rows();
  };

  it("answers the first accepted message exactly once", async () => {
    const rows = await send("First question about the garden");
    expect(rows).toMatchObject([{ kind: "text", from: { botId: responder }, text: "Hello from pi" }]);
    expect(prompts()).toBe(1);
  }, 30000);

  it.each(["entry", "speech", "claim"] as const)("ends an accepted turn visibly after a failed %s and releases the member", async phase => {
    const promptCount = prompts();
    const offset = readFileSync(server.info.logPath, "utf8").length;
    const flag = join(server.info.dataDir, "fail-room-entry");
    if (phase === "entry") writeFileSync(flag, "");
    else if (phase === "speech") db.exec(`CREATE TRIGGER fail_room_setup BEFORE INSERT ON speech_generations BEGIN SELECT RAISE(ABORT, 'fixture speech write failed'); END`);
    else db.exec(`CREATE TRIGGER fail_room_setup BEFORE INSERT ON room_requests WHEN NEW.verb='room_turn'
      BEGIN SELECT RAISE(ABORT, 'fixture claim write failed'); END`);
    try {
      const rows = await send(`Question during ${phase} failure`);
      expect(existsSync(flag)).toBe(false);
      const reason = phase === "entry" ? "fixture setup read failed" : `fixture ${phase} write failed`;
      const lines = readFileSync(server.info.logPath, "utf8").slice(offset).split("\n").filter(line => line.includes(reason));
      expect(rows, `accepted and idle after ${phase}: engine submissions=${prompts() - promptCount}, matching diagnostics=${lines.length}`).toMatchObject([{ kind: "activity", tool: { ok: false, name: "Alpha could not answer: it could not get ready. Try again in a moment." } }]);
      expect(prompts()).toBe(promptCount);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(group.threadId);
      expect(lines[0]).toContain(responder);
      const { bots } = await api<{ bots: { id: string; busy: boolean }[] }>("GET", "/api/bots?messages=0", 200);
      expect(bots.find(bot => bot.id === responder)!.busy).toBe(false);
    } finally {
      if (phase !== "entry") db.exec("DROP TRIGGER fail_room_setup");
    }
    expect(await send(`Question after ${phase} failure`)).toMatchObject([{ kind: "text", from: { botId: responder }, text: "Hello from pi" }]);
    expect(prompts()).toBe(promptCount + 1);
  }, 30000);

  it("keeps the successful reply as the only terminal row if request bookkeeping fails after dispatch", async () => {
    const before = prompts();
    const offset = readFileSync(server.info.logPath, "utf8").length;
    db.exec(`CREATE TRIGGER fail_room_finish BEFORE UPDATE OF state ON room_requests
      WHEN OLD.verb='room_turn' AND NEW.state='done' BEGIN SELECT RAISE(ABORT, 'fixture completion write failed'); END`);
    try {
      const rows = await send("Question before the completion write");
      expect(readFileSync(server.info.logPath, "utf8").slice(offset)).toContain("fixture completion write failed");
      expect(rows).toMatchObject([{ kind: "text", from: { botId: responder }, text: "Hello from pi" }]);
      expect(prompts()).toBe(before + 1);
    } finally {
      db.exec("DROP TRIGGER fail_room_finish");
    }
  }, 30000);

  it("refuses once before submission and identifies the turn if the index really is unavailable", async () => {
    db.exec(`DROP INDEX IF EXISTS ${OWNER_PIN_INDEX}`);
    const promptCount = prompts();
    const offset = readFileSync(server.info.logPath, "utf8").length;
    const rows = await send("Next question about the garden");
    expect(rows).toMatchObject([{ kind: "activity", tool: { ok: false, name: expect.stringContaining("pinned memory is still being prepared") } }]);
    expect(prompts()).toBe(promptCount);
    const log = readFileSync(server.info.logPath, "utf8").slice(offset).split("\n");
    expect(log.filter(line => line.includes(`thread=${group.threadId} member=${responder}`))).toEqual([
      `[turn] room dispatch refused thread=${group.threadId} member=${responder} cause=pin-projection-pending`,
    ]);
  }, 30000);
});

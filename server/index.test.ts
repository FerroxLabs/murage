// API smoke test: boots the real harness server (node server/index.ts)
// against a throwaway home directory and exercises the HTTP surface the
// app depends on. The config pins a local fake engine and inert shadow
// entries so the suite is deterministic with or without agent CLIs installed
// and exercises the shadow-instance behavior end to end.
// Part 1 of 4 (server/testing/index-harness.ts boots one server per file).
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { persistentAgentsClient } from "./testing/persistent-agents-client.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";
import { FILE_MAX_BYTES, IMAGE_MAX_BYTES } from "./attachments.ts";
import { redactSecretsInText } from "./redact.ts";
import { BASE, phoneApi, DESKTOP_HEADERS, DESKTOP_QUERY, DESKTOP_SECRET, FIXTURE_ENGINE_OVERRIDES, PORT, ROOT, SERVER_DIR, STATE_ONLY_SELECTION, api, deferredCheckpointDirectories, desktopApi, expectStoppedTestServerCleanly, fakeClaudeDump, home, readJsonFileWhenReady, startInternalFixtureTurn, statusWithHeaders, stderr, stopFixtureTurn, uploadAvatar, waitForIsolatedServer } from "./testing/index-harness.ts";


describe("harness HTTP API", () => {
  it("P20 refuses checkpoint restoration while another bot owns the same canonical project folder", async () => {
    // Match the lease's native canonical path from the outset. In particular,
    // a Windows TEMP short-name spelling is not the canonical-folder fixture.
    const project = realpathSync.native(mkdtempSync(join(home, "shared-restore-project-")));
    const alias = join(home, `shared-restore-alias-${Date.now()}`);
    const file = join(project, "work.txt");
    writeFileSync(file, "checkpoint contents");
    if (process.platform !== "win32") symlinkSync(project, alias);
    const restorer = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const worker = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${restorer.id}`, { cwd: project, computer: "off" })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${worker.id}`, { cwd: process.platform === "win32" ? project : alias, computer: "off" })).status).toBe(200);
      await startInternalFixtureTurn(restorer.id);
      const checkpointResponse = await desktopApi("GET", `/api/bots/${restorer.id}/checkpoints?cwd=${encodeURIComponent(project)}`);
      expect(checkpointResponse.status).toBe(200);
      const checkpointDiagnostics = JSON.stringify({
        response: checkpointResponse.body,
        warnings: stderr.split(/\r?\n/).filter(line => line.includes("workspace checkpoints disabled") && line.includes(restorer.id)).map(redactSecretsInText),
      });
      expect(checkpointResponse.body.enabled, checkpointDiagnostics).toBe(true);
      expect(checkpointResponse.body.checkpoints.length, checkpointDiagnostics).toBeGreaterThan(0);
      const checkpoint = checkpointResponse.body.checkpoints[0].hash;
      expect(checkpoint).toMatch(/^[a-f0-9]{40}$/);
      await api("POST", `/api/bots/${restorer.id}/interrupt`);
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === restorer.id)?.busy).toBe(false);
      writeFileSync(file, "newer work that must remain while another bot is active");
      await startInternalFixtureTurn(worker.id);
      const before = readFileSync(file, "utf8");
      const restored = await desktopApi("POST", `/api/bots/${restorer.id}/checkpoints/restore`, { cwd: project, hash: checkpoint });
      expect(restored.status, JSON.stringify({ response: restored.body, fileAfter: readFileSync(file, "utf8") })).toBe(409);
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      for (const bot of [restorer, worker]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`).catch(() => undefined);
        await desktopApi("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
      if (process.platform !== "win32") rmSync(alias, { force: true });
      // Windows retains directory handles until the owning fixture server closes.
      // The suite already removes this project's parent home after shutdown;
      // verify that deferred removal rather than racing it inside this test.
      if (process.platform === "win32") deferredCheckpointDirectories.push(project);
      else rmSync(project, { recursive: true, force: true });
    }
  }, 20000);

  it("persists structured provider 402 credit guidance from the real ACP error fold without raw secrets", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "murage-provider402-api-"));
    const data = join(isolatedHome, ".murage");
    const staticRoot = join(isolatedHome, "static");
    const port = await freePortBlock([0, 1]);
    mkdirSync(data);
    mkdirSync(join(staticRoot, "assets"), { recursive: true });
    writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>Provider error fixture</title>");
    writeFileSync(join(staticRoot, "assets", "smoke.css"), "body{}");
    mkdirSync(join(isolatedHome, ".grok"));
    writeFileSync(join(isolatedHome, ".grok", "auth.json"), "{}");
    writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {
      fixture402: { driver: "grokAgent", displayName: "Fixture 402", config: { cli: join(SERVER_DIR, "testing", "fake-acp-cli.ts") } },
    } }));
    const env: NodeJS.ProcessEnv = { HOME: isolatedHome, USERPROFILE: isolatedHome, MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticRoot, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET, FAKE_ACP_MODE: "credit-exhausted", PATH: process.env.PATH };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const isolatedChild = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
    let isolatedStderr = "";
    isolatedChild.stderr!.on("data", chunk => { isolatedStderr += chunk; });
    const request = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { ...DESKTOP_HEADERS, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    };
    try {
      await waitForIsolatedServer(isolatedChild, port, () => isolatedStderr);
      const created = await request("POST", "/api/bots", { modelSelection: { instanceId: "fixture402", model: "grok-4.6" } });
      expect(created.status).toBe(201);
      const bot = created.body.bot;
      expect((await request("PATCH", `/api/bots/${bot.id}`, { computer: "off", autoApprove: false })).status).toBe(200);
      expect((await request("POST", `/api/bots/${bot.id}/messages`, { text: "Trigger the fake credit-exhausted response only." })).status).toBe(202);
      let errorMessage: any;
      await expect.poll(async () => {
        const state = (await request("GET", "/api/bots?messages=50")).body.bots.find((entry: { id: string }) => entry.id === bot.id);
        errorMessage = state?.messages.find((message: any) => message.tool?.providerError?.kind === "credits");
        return Boolean(errorMessage) && state.busy === false;
      }, { timeout: 10000 }).toBe(true);
      expect(errorMessage).toMatchObject({ role: "bot", kind: "activity", tool: { ok: false, providerError: { kind: "credits", httpStatus: 402 } } });
      expect(errorMessage.tool.name).toContain("credit balance is exhausted");
      expect(errorMessage.tool.errorDetails).toContain("Provider response: HTTP 402");
      // The driver reads the engine's typed kind out of `error.data.error_kind`
      // and carries it as the runtime.error event's own `errorKind` field. That
      // field only matters if it survives the event bus, the store and the API
      // — the card reads it from the stored message, never from the text. This
      // is the whole pass-through, running for real.
      expect(errorMessage.tool.errorKind).toBe("api");
      expect(errorMessage.tool.errorDetails).toContain("Engine error kind: api");
      expect(errorMessage.tool.name.length).toBeLessThanOrEqual(167);
      expect(JSON.stringify(errorMessage)).not.toMatch(/fake-secret-canary|billing\.invalid|Internal error/);
      const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
      try {
        const persisted = JSON.parse(String(db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(bot.threadId, errorMessage.id)?.json));
        expect(persisted.tool.providerError).toEqual(errorMessage.tool.providerError);
        expect(persisted.tool.errorDetails).toBe(errorMessage.tool.errorDetails);
        expect(persisted.tool.errorKind).toBe("api");
        expect(JSON.stringify(persisted)).not.toMatch(/fake-secret-canary|billing\.invalid/);
      } finally { db.close(); }
    } finally {
      await waitForExit(isolatedChild, { signal: "SIGTERM" });
      await removeTempDir(isolatedHome);
    }
    expectStoppedTestServerCleanly(isolatedChild, isolatedStderr);
  }, 20000);

  it("rejects non-loopback authorities while accepting IPv4 and IPv6 loopback forms", async () => {
    expect(await statusWithHeaders({ host: "example.com" })).toBe(403);
    expect(await statusWithHeaders({ origin: "https://example.com" })).toBe(403);
    expect(await statusWithHeaders({ host: `127.0.0.2:${PORT}` })).toBe(200);
    expect(await statusWithHeaders({ host: `[::1]:${PORT}` })).toBe(200);
    expect(await statusWithHeaders({ origin: `http://[::1]:${PORT}` })).toBe(200);
  });

  // The skill index is built lazily by whichever request needs it first, and
  // all three of those requests are somebody looking at a screen (the library
  // panel's browse and search, and the new-bot intake's suggest). After an
  // install or an upgrade the fingerprint changes, so that first person used
  // to pay for the whole build while the machine had been idle since boot.
  it("warms the skill index at startup, before anyone asks for it", async () => {
    // No test in this file touches /api/library, so the only thing that can
    // have built this is the prewarm on the listen callback.
    const indexFile = join(home, ".murage", "skill-index.db");
    await expect.poll(() => existsSync(indexFile), { timeout: 25_000, interval: 250 }).toBe(true);
    // and the harness was answering the whole time it was being built — the
    // prewarm is fired after the port is open, never awaited on the way to it
    expect((await api("GET", "/api/health")).status).toBe(200);
  }, 30_000);

  it("identifies itself on /api/health", async () => {
    const { status, body } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.app).toBe("murage");
    expect(typeof body.pid).toBe("number");
    expect(body.static).toBe(true);
  });

  it("serves packaged UI assets and preserves API 404s", async () => {
    const root = await fetch(`${BASE}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toBe("text/html");
    expect(await root.text()).toContain("Packaged Murage");

    const asset = await fetch(`${BASE}/assets/smoke.css`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/css");
    expect(await asset.text()).toContain("color: white");

    const spa = await fetch(`${BASE}/settings/desktop`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toBe("text/html");
    expect(await spa.text()).toContain("Packaged Murage");

    // 0.1.61 deny by default: an unclassified route is desktop-only, so only
    // the desktop hears which route it asked for.
    const unknownApi = await desktopApi("GET", "/api/not-a-real-route");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.body.error).toContain("/api/not-a-real-route");
    expect(await api("GET", "/api/not-a-real-route")).toEqual({ status: 404, body: { error: "no such route" } });
  });

  it("serves the content-hashed diagram frame only as a sandboxed, opaque page", async () => {
    const frame = await fetch(`${BASE}/mermaid-frame-0123456789abcdef.html`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(await frame.text()).toContain("Diagram frame");
    // A stale hash is the SPA fallback, and carries no sandbox header. That
    // absence is what the browser door reads to refuse it rather than cache
    // the shell under a frame's name for a year.
    const stale = await fetch(`${BASE}/mermaid-frame-fedcba9876543210.html`);
    expect(await stale.text()).toContain("Packaged Murage");
    expect(stale.headers.get("content-security-policy")).toBeNull();
    expect((await fetch(`${BASE}/`)).headers.get("content-security-policy")).toBeNull();
  });

  it("rejects malformed and oversized JSON bodies without hanging", async () => {
    const malformed = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...DESKTOP_HEADERS },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });

    const oversized = await fetch(`${BASE}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...DESKTOP_HEADERS },
      body: JSON.stringify({ profile: { name: "x".repeat(1_000_001) } }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "body too large" });

    expect((await fetch(`${BASE}/api/health`)).status).toBe(200);
  });

  it("seeds one starter bot, and it says nothing until the first run does", async () => {
    const { status, body } = await api("GET", "/api/bots");
    expect(status).toBe(200);
    expect(body.bots.length).toBeGreaterThanOrEqual(1);
    // It used to open with a greeting and a card asking what you wanted it
    // for. Both were written for a bot you add LATER, and on the first bot on
    // the first launch they landed ABOVE the guided first run's own opening
    // card, because they are written at bot creation and its card arrives
    // after. The flow introduces this bot properly; nothing speaks before it.
    expect(body.bots[0].messages).toEqual([]);
  });

  it("projects privacy-safe live team-map metadata", async () => {
    const response = await desktopApi("GET", "/api/team-map");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ collaborations: expect.any(Array), queued: [], running: [] });
    for (const collaboration of response.body.collaborations) {
      expect(collaboration).toEqual({
        groupId: expect.any(String),
        botIds: [expect.any(String), expect.any(String)],
        lastAt: expect.any(Number),
      });
    }
    expect(JSON.stringify(response.body)).not.toContain("messages");
    expect(JSON.stringify(response.body)).not.toContain("prompt");
  });

  it("rejects non-object bot and channel create bodies without writing records", async () => {
    const before = await api("GET", "/api/bots?messages=0");
    for (const path of ["/api/bots", "/api/groups"]) {
      for (const body of ["null", "[]"]) {
        const response = await fetch(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: expect.stringMatching(/JSON object/) });
      }
    }
    const after = await api("GET", "/api/bots?messages=0");
    expect(after.body.bots).toHaveLength(before.body.bots.length);
    expect(after.body.groups).toHaveLength(before.body.groups.length);
  });

  it("adds and removes room members through PATCH", async () => {
    const [first, second, third] = await Promise.all([
      desktopApi("POST", "/api/bots"),
      desktopApi("POST", "/api/bots"),
      desktopApi("POST", "/api/bots"),
    ]).then((created) => created.map((response) => response.body.bot));
    const room = (await api("POST", "/api/groups", { name: "Roster", memberIds: [first.id, second.id] })).body.group;
    try {
      const added = await desktopApi("PATCH", `/api/groups/${room.id}`, { memberIds: [first.id, second.id, third.id] });
      expect(added.status).toBe(200);
      expect(added.body.group.memberIds).toEqual([first.id, second.id, third.id]);

      const removed = await desktopApi("PATCH", `/api/groups/${room.id}`, { memberIds: [third.id] });
      expect(removed.status).toBe(200);
      expect(removed.body.group.memberIds).toEqual([third.id]);

      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).memberIds).toEqual([third.id]);
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      for (const bot of [first, second, third]) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses to empty a room's roster", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Never empty", memberIds: [bot.id] })).body.group;
    try {
      for (const memberIds of [[], ["no-such-bot"]]) {
        const attempted = await desktopApi("PATCH", `/api/groups/${room.id}`, { memberIds });
        expect(attempted.status).toBe(400);
        expect(attempted.body.error).toMatch(/at least one bot|unknown room member/i);
      }
      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).memberIds).toEqual([bot.id]);
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses a room whose every member is archived", async () => {
    const [archived, active] = await Promise.all([desktopApi("POST", "/api/bots"), desktopApi("POST", "/api/bots")]).then(
      (created) => created.map((response) => response.body.bot),
    );
    await desktopApi("PATCH", `/api/bots/${archived.id}`, { hidden: true });
    try {
      const refused = await api("POST", "/api/groups", { name: "All archived", memberIds: [archived.id] });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/at least one active bot/i);

      // one active member is enough — the archived one may still ride along
      const created = await api("POST", "/api/groups", {
        name: "Mixed roster",
        memberIds: [archived.id, active.id],
      });
      expect(created.status).toBe(201);
      await desktopApi("DELETE", `/api/groups/${created.body.group.id}`);
    } finally {
      for (const bot of [archived, active]) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deduplicates repeated room members while preserving their first-seen order", async () => {
    const [first, second] = await Promise.all([desktopApi("POST", "/api/bots"), desktopApi("POST", "/api/bots")]).then(
      (created) => created.map((response) => response.body.bot),
    );
    const room = (await api("POST", "/api/groups", { name: "Unique roster", memberIds: [first.id] })).body.group;
    try {
      const patched = await desktopApi("PATCH", `/api/groups/${room.id}`, {
        memberIds: [second.id, first.id, second.id, first.id],
      });
      expect(patched.status).toBe(200);
      expect(patched.body.group.memberIds).toEqual([second.id, first.id]);
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      for (const bot of [first, second]) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("keeps direct-message channels a fixed pair at the API boundary", async () => {
    const attempted = await desktopApi("PATCH", "/api/groups/test-dm", { memberIds: ["test-bot-a"] });
    expect(attempted.status).toBe(400);
    expect(attempted.body.error).toMatch(/direct-message.*members/i);
    // dm channels are withheld from a scoped roster by design, so this
    // assertion has to ask as the desktop
    const state = await api("GET", `/api/bots?${DESKTOP_QUERY}`);
    const dm = state.body.groups.find((group: { id: string }) => group.id === "test-dm");
    expect(dm.memberIds).toEqual(["test-bot-a", "test-bot-b"]);
  });

  it("hands the lead to a remaining member when the lead leaves the room", async () => {
    const [lead, other] = await Promise.all([desktopApi("POST", "/api/bots"), desktopApi("POST", "/api/bots")]).then((created) =>
      created.map((response) => response.body.bot),
    );
    const room = (await api("POST", "/api/groups", { name: "Handover", memberIds: [lead.id, other.id] })).body.group;
    try {
      expect(room.defaultResponder).toEqual({ kind: "member", botId: lead.id });
      const patched = await desktopApi("PATCH", `/api/groups/${room.id}`, { memberIds: [other.id] });
      expect(patched.status).toBe(200);
      expect(patched.body.group.defaultResponder).toEqual({ kind: "member", botId: other.id });
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      for (const bot of [lead, other]) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deletes an archived bot for good, hands its lead seat over, and keeps the room", async () => {
    const [archived, keeper] = await Promise.all([desktopApi("POST", "/api/bots"), desktopApi("POST", "/api/bots")]).then((created) =>
      created.map((response) => response.body.bot),
    );
    const room = (await api("POST", "/api/groups", { name: "Survivor", memberIds: [archived.id, keeper.id] })).body.group;
    let roomAlive = true;
    try {
      expect(room.defaultResponder).toEqual({ kind: "member", botId: archived.id });
      // the archived list's delete carries a precondition: an active bot is
      // refused whole, because what the person confirmed was an archived one
      const stillActive = await desktopApi("DELETE", `/api/bots/${archived.id}?ifArchived=1`);
      expect(stillActive.status).toBe(409);
      expect(stillActive.body.error).toMatch(/no longer archived/i);
      const listed = async () => (await api("GET", "/api/bots")).body.bots.some((bot: { id: string }) => bot.id === archived.id);
      expect(await listed()).toBe(true);

      expect((await desktopApi("PATCH", `/api/bots/${archived.id}`, { hidden: true })).status).toBe(200);
      const deleted = await desktopApi("DELETE", `/api/bots/${archived.id}?ifArchived=1`);
      expect(deleted.status).toBe(200);
      expect(await listed()).toBe(false);
      // a repeat is a clean 404, not a second teardown
      expect((await desktopApi("DELETE", `/api/bots/${archived.id}?ifArchived=1`)).status).toBe(404);

      const state = (await api("GET", "/api/bots")).body;
      const survivor = state.groups.find((candidate: { id: string }) => candidate.id === room.id);
      expect(survivor).toBeTruthy();
      expect(survivor.memberIds).toEqual([keeper.id]);
      expect(survivor.defaultResponder).toEqual({ kind: "member", botId: keeper.id });
      expect(state.bots.some((bot: { id: string }) => bot.id === keeper.id)).toBe(true);
      expect(state.bots.some((bot: { id: string }) => bot.id === archived.id)).toBe(false);
    } finally {
      if (roomAlive) await desktopApi("DELETE", `/api/groups/${room.id}`);
      roomAlive = false;
      await desktopApi("DELETE", `/api/bots/${keeper.id}`);
      await desktopApi("DELETE", `/api/bots/${archived.id}`).catch(() => undefined);
    }
  });

  it("persists room setup and blocks the first message until it is finished", async () => {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    const created = await api("POST", "/api/groups", { name: "Setup probe", memberIds: [bot.id] });
    expect(created.status).toBe(201);
    const group = created.body.group;
    try {
      expect(group).toMatchObject({ setupCompletedAt: null, setupSkippedAt: null, messages: [] });
      const blocked = await desktopApi("POST", `/api/groups/${group.id}/messages`, { text: "before setup" });
      expect(blocked.status).toBe(409);
      expect((await api("GET", "/api/bots")).body.groups.find((candidate: { id: string }) => candidate.id === group.id).messages).toHaveLength(0);

      const invalid = await desktopApi("PATCH", `/api/groups/${group.id}/setup`, {
        action: "complete",
        cwd: null,
        bulletin: "",
        defaultResponder: { kind: "member", botId: "missing" },
      });
      expect(invalid.status).toBe(400);

      const completed = await desktopApi("PATCH", `/api/groups/${group.id}/setup`, {
        action: "complete",
        cwd: null,
        bulletin: "shared brief",
        defaultResponder: { kind: "member", botId: bot.id },
      });
      expect(completed.status).toBe(200);
      expect(completed.body.group).toMatchObject({ bulletin: "shared brief", setupCompletedAt: expect.any(Number) });
      expect((await api("GET", "/api/bots")).body.groups.find((candidate: { id: string }) => candidate.id === group.id)).toMatchObject({
        bulletin: "shared brief",
        setupSkippedAt: null,
      });
    } finally {
      await desktopApi("DELETE", `/api/groups/${group.id}`);
    }
  });

  it("creates an MCP-ready channel in one request without exposing partial setup", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const created = await api("POST", "/api/groups", {
      name: "Atomic setup",
      memberIds: [bot.id],
      section: "Work",
      setup: {
        bulletin: "Keep updates concise.",
        defaultResponder: { kind: "mentions" },
      },
    });
    expect(created.status).toBe(201);
    const group = created.body.group;
    try {
      expect(group).toMatchObject({
        name: "Atomic setup",
        memberIds: [bot.id],
        section: "Work",
        bulletin: "Keep updates concise.",
        defaultResponder: { kind: "mentions" },
        setupSkippedAt: null,
      });
      expect(group.setupCompletedAt).toEqual(expect.any(Number));
      expect((await desktopApi("POST", `/api/groups/${group.id}/messages`, { text: "A quiet update" })).status).toBe(202);
    } finally {
      await api("POST", `/api/groups/${group.id}/interrupt`, {});
      await desktopApi("DELETE", `/api/groups/${group.id}`);
    }
  });

  it("returns the canonical stored user message for direct and channel sends", async () => {
    const created = await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    let room: any;
    try {
      const direct = await desktopApi("POST", `/api/bots/${bot.id}/messages`, { text: "canonical direct" });
      expect(direct.status).toBe(202);
      expect(direct.body).toMatchObject({
        ok: true,
        threadId: bot.threadId,
        message: {
          id: expect.any(String),
          at: expect.any(Number),
          role: "user",
          kind: "text",
          text: "canonical direct",
        },
      });
      const afterDirect = (await api("GET", "/api/bots?messages=20")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(afterDirect.messages.find((message: { id: string }) => message.id === direct.body.message.id))
        .toEqual(direct.body.message);

      expect((await api("POST", `/api/bots/${bot.id}/interrupt`)).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        return state.bots.find((candidate: { id: string }) => candidate.id === bot.id)?.busy;
      }, { timeout: 5_000 }).toBe(false);

      room = (await api("POST", "/api/groups", {
        name: "Canonical response room",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
      })).body.group;
      const channel = await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "canonical channel" });
      expect(channel.status).toBe(202);
      expect(channel.body).toMatchObject({
        ok: true,
        threadId: room.threadId,
        message: {
          id: expect.any(String),
          at: expect.any(Number),
          role: "user",
          kind: "text",
          text: "canonical channel",
        },
      });
      const afterChannel = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(afterChannel.messages.find((message: { id: string }) => message.id === channel.body.message.id))
        .toEqual(channel.body.message);
    } finally {
      if (room) await desktopApi("DELETE", `/api/groups/${room.id}`);
      await api("POST", `/api/bots/${bot.id}/interrupt`).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deduplicates direct send retries by sendId, including after the accepted task becomes inactive", async () => {
    const created = await desktopApi("POST", "/api/bots", {
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const originalThreadId = bot.threadId;
    const sendId = "direct_retry_1234567890";
    const request = { text: "retry this direct message once", threadId: originalThreadId, sendId };
    try {
      const first = await desktopApi("POST", `/api/bots/${bot.id}/messages`, request);
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({
        ok: true,
        threadId: originalThreadId,
        message: { role: "user", kind: "text", text: request.text, sendId },
      });

      const duplicate = await desktopApi("POST", `/api/bots/${bot.id}/messages`, request);
      expect(duplicate.status).toBe(202);
      expect(duplicate.body).toEqual(first.body);

      const conflict = await desktopApi("POST", `/api/bots/${bot.id}/messages`, {
        ...request,
        text: "a different message cannot reuse that identity",
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toMatch(/sendId already belongs/i);

      const invalid = await desktopApi("POST", `/api/bots/${bot.id}/messages`, {
        text: "invalid identity must not land",
        threadId: originalThreadId,
        sendId: "short",
      });
      expect(invalid.status).toBe(400);

      const accepted = (await api("GET", "/api/bots?messages=50")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(accepted.messages.filter((message: { role: string; sendId?: string }) =>
        message.role === "user" && message.sendId === sendId
      )).toHaveLength(1);
      expect(accepted.messages.some((message: { text?: string }) => message.text === "invalid identity must not land"))
        .toBe(false);

      await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: originalThreadId });
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body.bots.find(
          (candidate: { id: string }) => candidate.id === bot.id,
        );
        return state?.busy;
      }, { timeout: 5_000 }).toBe(false);

      const nextTask = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Now active" });
      expect(nextTask.status).toBe(201);
      expect(nextTask.body.task.threadId).not.toBe(originalThreadId);

      const inactiveRetry = await desktopApi("POST", `/api/bots/${bot.id}/messages`, request);
      expect(inactiveRetry.status).toBe(202);
      expect(inactiveRetry.body).toEqual(first.body);
      const current = (await api("GET", "/api/bots?messages=0")).body.bots.find(
        (candidate: { id: string }) => candidate.id === bot.id,
      );
      expect(current.threadId).toBe(nextTask.body.task.threadId);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("deduplicates channel send retries by sendId", async () => {
    const member = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const room = (await api("POST", "/api/groups", {
      name: "Idempotent channel",
      memberIds: [member.id],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } },
    })).body.group;
    const sendId = "channel_retry_123456789";
    const request = { text: "one canonical channel message", threadId: room.threadId, sendId };
    try {
      const first = await desktopApi("POST", `/api/groups/${room.id}/messages`, request);
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({
        ok: true,
        threadId: room.threadId,
        message: { role: "user", kind: "text", text: request.text, sendId },
      });

      const duplicate = await desktopApi("POST", `/api/groups/${room.id}/messages`, request);
      expect(duplicate.status).toBe(202);
      expect(duplicate.body).toEqual(first.body);

      const snapshot = (await api("GET", "/api/bots?messages=50")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(snapshot.messages.filter((message: { role: string; sendId?: string }) =>
        message.role === "user" && message.sendId === sendId
      )).toHaveLength(1);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
      await desktopApi("DELETE", `/api/groups/${room.id}`);
    }
  });

  it("rejects an entire channel roster when any requested member is unknown", async () => {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots[0];
    const before = (await api("GET", "/api/bots?messages=0")).body.groups.length;
    const rejectedCreate = await api("POST", "/api/groups", {
      name: "No partial roster",
      memberIds: [bot.id, "missing-bot"],
    });
    expect(rejectedCreate.status).toBe(400);
    expect(rejectedCreate.body.error).toContain("missing-bot");
    expect((await api("GET", "/api/bots?messages=0")).body.groups).toHaveLength(before);

    const room = (await api("POST", "/api/groups", { name: "Stable roster", memberIds: [bot.id] })).body.group;
    try {
      const rejectedPatch = await desktopApi("PATCH", `/api/groups/${room.id}`, {
        memberIds: [bot.id, "missing-bot"],
      });
      expect(rejectedPatch.status).toBe(400);
      const reread = (await api("GET", "/api/bots?messages=0")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(reread.memberIds).toEqual([bot.id]);
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
    }
  });

  it("creates, switches, renames and deletes independent channel tasks", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Parallel work", memberIds: [bot.id] })).body.group;
    try {
      expect(room.tasks).toHaveLength(1);
      expect(room.tasks[0].threadId).toBe(room.threadId);
      const originalThread = room.threadId;

      const created = await api("POST", `/api/groups/${room.id}/tasks`, { title: "Launch plan" });
      expect(created.status).toBe(201);
      expect(created.body.group.threadId).toBe(created.body.task.threadId);
      expect(created.body.group.messages).toEqual([]);
      expect(created.body.group.tasks).toHaveLength(2);

      const newThread = created.body.task.threadId;
      const renamed = await api("PATCH", `/api/groups/${room.id}/tasks/${newThread}`, {
        title: "Release plan",
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.task.title).toBe("Release plan");

      const switched = await api("POST", `/api/groups/${room.id}/tasks/${originalThread}`);
      expect(switched.status).toBe(200);
      expect(switched.body.group.threadId).toBe(originalThread);
      expect(switched.body.group.tasks.find((task: { threadId: string }) => task.threadId === newThread).title).toBe("Release plan");

      const removed = await desktopApi("DELETE", `/api/groups/${room.id}/tasks/${newThread}`);
      expect(removed.status).toBe(200);
      expect(removed.body.group.tasks).toHaveLength(1);
      // the last conversation goes too, and a fresh one takes its place
      const last = await desktopApi("DELETE", `/api/groups/${room.id}/tasks/${originalThread}`);
      expect(last.status).toBe(200);
      expect(last.body.group.tasks).toHaveLength(1);
      expect(last.body.group.threadId).not.toBe(originalThread);
      expect((await api("POST", `/api/groups/${room.id}/tasks/missing-thread`)).status).toBe(404);
      expect((await api("POST", `/api/groups/${room.id}/tasks`, { title: 42 })).status).toBe(400);
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("lets a Chief create operators from its direct and channel tasks but not from channels it cannot access", async () => {
    const chief = (await desktopApi("POST", "/api/bots")).body.bot;
    const outsider = (await desktopApi("POST", "/api/bots")).body.bot;
    let channel: any;
    let outsiderChannel: any;
    const createdBotIds: string[] = [];
    try {
      const selected = await desktopApi("PATCH", `/api/bots/${chief.id}`, {
        name: "Channel Chief",
        section: "Channel creation test",
        chiefOfStaff: true,
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      });
      expect(selected.status).toBe(200);

      let internalHeaders = (await startInternalFixtureTurn(chief.id)).headers;

      const createOperator = async (fromThreadId: string, name: string, fromBotId = chief.id) => {
        const response = await fetch(`${BASE}/api/internal/create-bot`, {
          method: "POST",
          headers: internalHeaders,
          body: JSON.stringify({
            fromBotId,
            fromThreadId,
            name,
            role: "Research operator",
            instructions: "Research the assigned question and report concise findings.",
          }),
        });
        const body = z.object({
          id: z.string().optional(),
          section: z.string().optional(),
          error: z.string().optional(),
        }).passthrough().parse(await response.json());
        if (response.status === 201 && body.id) createdBotIds.push(body.id);
        return { status: response.status, body };
      };

      const direct = await createOperator(chief.threadId, "Direct Task Operator");
      expect(direct).toMatchObject({ status: 201, body: { section: "Channel creation test" } });
      expect((await api("POST", `/api/bots/${chief.id}/interrupt`)).status).toBe(200);

      channel = (await api("POST", "/api/groups", {
        name: "Chief member channel",
        memberIds: [chief.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: chief.id } },
      })).body.group;
      const rootThreadId = channel.threadId;
      internalHeaders = (await startInternalFixtureTurn(chief.id, channel.id)).headers;
      const rootTask = await createOperator(rootThreadId, "Channel Root Operator");
      expect(rootTask.status).toBe(201);
      expect((await api("POST", `/api/groups/${channel.id}/interrupt`, { threadId: rootThreadId })).status).toBe(200);
      await expect.poll(async () => {
        const state = (await api("GET", "/api/bots?messages=0")).body;
        const group = state.groups.find((item: { id: string }) => item.id === channel.id);
        return { working: group?.working, busyBotId: group?.busyBotId,
          botBusy: state.bots.find((item: { id: string }) => item.id === chief.id)?.busy };
      }, { timeout: 5_000 }).toEqual({ working: false, busyBotId: null, botBusy: false });
      const channelTask = await api("POST", `/api/groups/${channel.id}/tasks`, { title: "Research task" });
      expect(channelTask.status).toBe(201);
      internalHeaders = (await startInternalFixtureTurn(chief.id, channel.id)).headers;
      const nestedTask = await createOperator(channelTask.body.task.threadId, "Channel Task Operator");
      expect(nestedTask.status).toBe(201);

      outsiderChannel = (await api("POST", "/api/groups", {
        name: "Outsider-only channel",
        memberIds: [outsider.id],
        setup: { bulletin: "", defaultResponder: { kind: "member", botId: outsider.id } },
      })).body.group;
      const chiefHeaders = internalHeaders;
      internalHeaders = (await startInternalFixtureTurn(outsider.id, outsiderChannel.id)).headers;
      const nonChief = await createOperator(outsiderChannel.threadId, "Non-Chief Operator", outsider.id);
      expect(nonChief).toEqual({
        status: 403,
        body: { error: "only a section's Chief of Staff can create operator bots" },
      });
      internalHeaders = chiefHeaders;
      const denied = await createOperator(outsiderChannel.threadId, "Forbidden Operator");
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBeTruthy();
      const state = (await api("GET", "/api/bots?messages=0")).body;
      expect(state.bots.some((bot: { name: string }) => bot.name === "Forbidden Operator")).toBe(false);
    } finally {
      await api("POST", `/api/bots/${chief.id}/interrupt`);
      if (outsiderChannel?.id) {
        await api("POST", `/api/groups/${outsiderChannel.id}/interrupt`, { threadId: outsiderChannel.threadId });
        await desktopApi("DELETE", `/api/groups/${outsiderChannel.id}`);
      }
      if (channel?.id) {
        await api("POST", `/api/groups/${channel.id}/interrupt`);
        await desktopApi("DELETE", `/api/groups/${channel.id}`);
      }
      for (const botId of createdBotIds) await desktopApi("DELETE", `/api/bots/${botId}`);
      await desktopApi("DELETE", `/api/bots/${outsider.id}`);
      await desktopApi("DELETE", `/api/bots/${chief.id}`);
    }
  });

  it("create_bot operators inherit the Chief's Auto only when a human enabled it, computer off (AUTOOP1)", async () => {
    // The parked feature made every Chief-created operator start in Auto —
    // a model granting itself unattended tools. Shipped form: the operator
    // inherits exactly the Auto bit the person switched on for the Chief in
    // the calling conversation, and never from an unattended turn.
    const chief = (await desktopApi("POST", "/api/bots")).body.bot;
    const createdIds: string[] = [];
    let webhookId: string | undefined;
    const createOperator = async (headers: Record<string, string>, fromThreadId: string, name: string) => {
      const response = await fetch(`${BASE}/api/internal/create-bot`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fromBotId: chief.id, fromThreadId, name, role: "Research operator", instructions: "Report concise findings." }),
      });
      const body = (await response.json()) as { id?: string; auto?: boolean; error?: string };
      if (body.id) createdIds.push(body.id);
      const state = (await api("GET", "/api/bots?messages=0")).body;
      const operator = state.bots.find((bot: { id: string }) => bot.id === body.id);
      return { status: response.status, body, operator };
    };
    try {
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, {
        section: "Auto inheritance test",
        chiefOfStaff: true,
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);

      // 1. Chief in Ask mode: the operator asks too. Nothing about the call
      //    can turn Auto on.
      let turn = await startInternalFixtureTurn(chief.id);
      const asking = await createOperator(turn.headers, chief.threadId, "Asking operator");
      expect(asking.status).toBe(201);
      expect(asking.body.auto).toBe(false);
      expect(asking.operator).toMatchObject({ autoApprove: false, computer: "off", approvePeerComms: false, composio: false });
      expect(asking.operator.tasks[0]).toMatchObject({ autoApprove: false });
      await stopFixtureTurn(chief.id, turn);

      // 2. The person put the Chief in Auto — acknowledging the local-computer
      //    warning, since a Chief that never chose a computer drives this Mac
      //    (AUTOOP2 finding 1): the operator inherits it, with the computer
      //    OFF so this Auto can never drive the person's desktop.
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, { autoApprove: true, acknowledgeLocalAuto: true })).status).toBe(200);
      turn = await startInternalFixtureTurn(chief.id);
      const auto = await createOperator(turn.headers, chief.threadId, "Auto operator");
      expect(auto.status).toBe(201);
      expect(auto.body.auto).toBe(true);
      expect(auto.operator).toMatchObject({ autoApprove: true, computer: "off", approvePeerComms: false, composio: false });
      expect(auto.operator.tasks[0]).toMatchObject({ autoApprove: true });
      expect(auto.operator.alwaysAllow ?? []).toEqual([]);
      await stopFixtureTurn(chief.id, turn);

      // 3. Same Chief, same Auto, but the turn was started by a webhook with
      //    nobody at the keyboard: an unattended turn hands out no Auto.
      const hook = await desktopApi("POST", "/api/webhooks", {
        name: "Team builder",
        prompt: "__fixture_hold_authority__",
        botId: chief.id,
        runOn: "ember",
      });
      expect(hook.status).toBe(201);
      webhookId = hook.body.webhook.id;
      rmSync(fakeClaudeDump, { force: true });
      const delivered = await fetch(hook.body.credential.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "build the team" }),
      });
      expect(delivered.status).toBe(202);
      const dump = await readJsonFileWhenReady<{ pid: number; mcpConfig: { mcpServers: { agents: { env: Record<string, string> } } } }>(fakeClaudeDump, 20_000);
      const env = dump.mcpConfig.mcpServers.agents.env;
      expect(env.MURAGE_BOT_ID).toBe(chief.id);
      expect(env.MURAGE_THREAD_ID).not.toBe(chief.threadId);
      const unattended = await createOperator(
        { authorization: `Bearer ${env.MURAGE_COMMS_TOKEN}`, "content-type": "application/json" },
        env.MURAGE_THREAD_ID,
        "Webhook operator",
      );
      expect(unattended.status).toBe(201);
      expect(unattended.body.auto).toBe(false);
      expect(unattended.operator).toMatchObject({ autoApprove: false, computer: "off" });
      expect(unattended.operator.tasks[0]).toMatchObject({ autoApprove: false });
      writeFileSync(join(home, "finish-fake", String(dump.pid)), "finish");
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === chief.id)?.busy, { timeout: 10_000 }).toBe(false);
    } finally {
      await api("POST", `/api/bots/${chief.id}/interrupt`);
      if (webhookId) await desktopApi("DELETE", `/api/webhooks/${webhookId}`);
      for (const botId of createdIds) await desktopApi("DELETE", `/api/bots/${botId}`);
      await desktopApi("DELETE", `/api/bots/${chief.id}`);
    }
  }, 60_000);

  it("create_bot reads the Auto of the task that calls it, not the Chief's profile bit (AUTOOP2 finding 2)", async () => {
    // AUTOOP1's scenario had one task, so the profile bit and the task bit
    // always agreed and a resolver that read the profile would have passed.
    // Here the Chief has two tasks — A in Ask, B in Auto — and the profile
    // bit is ON: an operator created from A must ask, one created from B
    // must not. Mutation-checked: resolving `chief.autoApprove` instead of
    // `store.projectBotForTask(chief.id, fromThreadId)` yields Auto from A.
    const chief = (await desktopApi("POST", "/api/bots")).body.bot;
    const taskA: string = chief.threadId;
    let taskB: string | undefined;
    const createdIds: string[] = [];
    const chiefTasks = async () => {
      const state = (await api("GET", "/api/bots?messages=0")).body;
      return state.bots.find((bot: { id: string }) => bot.id === chief.id).tasks as Array<{ threadId: string; autoApprove: boolean }>;
    };
    const createOperator = async (headers: Record<string, string>, fromThreadId: string, name: string) => {
      const response = await fetch(`${BASE}/api/internal/create-bot`, {
        method: "POST",
        headers,
        body: JSON.stringify({ fromBotId: chief.id, fromThreadId, name, role: "Research operator", instructions: "Report concise findings." }),
      });
      const body = (await response.json()) as { id?: string; auto?: boolean; error?: string };
      if (body.id) createdIds.push(body.id);
      const state = (await api("GET", "/api/bots?messages=0")).body;
      const operator = state.bots.find((bot: { id: string }) => bot.id === body.id);
      return { status: response.status, body, operator };
    };
    // A multi-task bot's Stop must name the thread (independent threads).
    const settle = (threadId: string, turn: { dump: { pid: number } }) => stopFixtureTurn(chief.id, turn, threadId);
    try {
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, {
        section: "Auto inheritance test",
        chiefOfStaff: true,
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      })).status).toBe(200);
      taskB = (await api("POST", `/api/bots/${chief.id}/tasks`, { title: "Auto task" })).body.task.threadId as string;
      expect(taskB).not.toBe(taskA);
      // Task B in Auto (acknowledged — a Chief with no chosen computer drives
      // this Mac), then the profile bit ON as a default that leaves A alone.
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}/tasks/${taskB}`, { autoApprove: true, acknowledgeLocalAuto: true })).status).toBe(200);
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, { settingsScope: "defaults", autoApprove: true, acknowledgeLocalAuto: true })).status).toBe(200);
      const stored = JSON.parse(readFileSync(join(home, ".murage", "bots.json"), "utf8")).find((entry: { id: string }) => entry.id === chief.id);
      expect(stored.autoApprove).toBe(true);
      expect(await chiefTasks()).toEqual(expect.arrayContaining([
        expect.objectContaining({ threadId: taskA, autoApprove: false }),
        expect.objectContaining({ threadId: taskB, autoApprove: true }),
      ]));

      // From task A (Ask): the operator asks, whatever the profile says.
      expect((await api("POST", `/api/bots/${chief.id}/tasks/${taskA}`)).status).toBe(200);
      let turn = await startInternalFixtureTurn(chief.id);
      expect(turn.env.MURAGE_THREAD_ID).toBe(taskA);
      const fromAsk = await createOperator(turn.headers, taskA, "Operator from task A");
      expect(fromAsk.status).toBe(201);
      expect(fromAsk.body.auto).toBe(false);
      expect(fromAsk.operator).toMatchObject({ autoApprove: false, computer: "off" });
      expect(fromAsk.operator.tasks[0]).toMatchObject({ autoApprove: false });
      await settle(taskA, turn);

      // From task B (Auto): the operator inherits it, computer off.
      expect((await api("POST", `/api/bots/${chief.id}/tasks/${taskB}`)).status).toBe(200);
      turn = await startInternalFixtureTurn(chief.id);
      expect(turn.env.MURAGE_THREAD_ID).toBe(taskB);
      const fromAuto = await createOperator(turn.headers, taskB, "Operator from task B");
      expect(fromAuto.status).toBe(201);
      expect(fromAuto.body.auto).toBe(true);
      expect(fromAuto.operator).toMatchObject({ autoApprove: true, computer: "off", approvePeerComms: false, composio: false });
      expect(fromAuto.operator.tasks[0]).toMatchObject({ autoApprove: true });
      await settle(taskB, turn);

      // And the other way round: profile bit OFF, task B still Auto — the
      // live task bit is what create_bot reads, in both directions.
      expect((await desktopApi("PATCH", `/api/bots/${chief.id}`, { settingsScope: "defaults", autoApprove: false })).status).toBe(200);
      expect(await chiefTasks()).toEqual(expect.arrayContaining([expect.objectContaining({ threadId: taskB, autoApprove: true })]));
      turn = await startInternalFixtureTurn(chief.id);
      expect(turn.env.MURAGE_THREAD_ID).toBe(taskB);
      const stillAuto = await createOperator(turn.headers, taskB, "Operator from task B again");
      expect(stillAuto.status).toBe(201);
      expect(stillAuto.body.auto).toBe(true);
      expect(stillAuto.operator).toMatchObject({ autoApprove: true, computer: "off" });
      await settle(taskB, turn);
    } finally {
      for (const threadId of [taskA, taskB]) if (threadId) await api("POST", `/api/bots/${chief.id}/interrupt`, { threadId });
      for (const botId of createdIds) await desktopApi("DELETE", `/api/bots/${botId}`);
      await desktopApi("DELETE", `/api/bots/${chief.id}`);
    }
  }, 60_000);

  it("rejects null and array task, channel, and bot mutation bodies", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Object bodies", memberIds: [bot.id] })).body.group;
    try {
      const routes = [
        ["POST", `/api/groups/${room.id}/tasks`, false],
        ["PATCH", `/api/groups/${room.id}/tasks/${room.threadId}`, false],
        ["PATCH", `/api/groups/${room.id}`, true],
        ["PATCH", `/api/bots/${bot.id}`, true],
      ] as const;
      for (const [method, path, desktop] of routes) {
        for (const body of ["null", "[]"]) {
          const response = await fetch(`${BASE}${path}`, {
            method,
            headers: { "content-type": "application/json", ...(desktop ? DESKTOP_HEADERS : {}) },
            body,
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: "body must be a JSON object" });
        }
      }
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("keeps bot-to-bot channels single-threaded and blocks task changes on an open approval", async () => {
    // a bot-to-bot room is not there for any surface but the desktop's
    expect((await api("POST", "/api/groups/test-dm/tasks", {})).status).toBe(404);
    const dm = await desktopApi("POST", "/api/groups/test-dm/tasks", {});
    expect(dm.status).toBe(400);
    expect(dm.body.error).toMatch(/one canonical conversation/i);

    const blocked = await api("POST", "/api/groups/test-stranded-room/tasks", {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/waiting on you/i);
  });

  it("keeps direct-message channels folderless at the API boundary", async () => {
    const attempted = await desktopApi("PATCH", "/api/groups/test-dm", { cwd: home });
    expect(attempted.status).toBe(400);
    expect(attempted.body.error).toMatch(/direct-message.*working folder/i);
    // dm channels are withheld from a scoped roster by design, so this
    // assertion has to ask as the desktop
    const state = await api("GET", `/api/bots?${DESKTOP_QUERY}`);
    expect(state.body.groups.find((group: { id: string }) => group.id === "test-dm")).not.toHaveProperty("cwd");
    expect((await desktopApi("DELETE", "/api/groups/test-dm")).status).toBe(200);
  });

  it("rejects working-folder changes after a room has pinned its first turn", async () => {
    const attempted = await desktopApi("PATCH", "/api/groups/test-pinned-room", { cwd: home });
    expect(attempted.status).toBe(409);
    expect(attempted.body.error).toMatch(/fixed after its first turn/i);
    // dm channels are withheld from a scoped roster by design, so this
    // assertion has to ask as the desktop
    const state = await api("GET", `/api/bots?${DESKTOP_QUERY}`);
    expect(state.body.groups.find((group: { id: string }) => group.id === "test-pinned-room")).not.toHaveProperty("cwd");
    expect((await desktopApi("DELETE", "/api/groups/test-pinned-room")).status).toBe(200);
  });

  it("renames rooms through a bounded non-empty name", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Old room", memberIds: [bot.id] })).body.group;
    try {
      const renamed = await desktopApi("PATCH", `/api/groups/${room.id}`, { name: "  Project Atlas  " });
      expect(renamed.status).toBe(200);
      expect(renamed.body.group.name).toBe("Project Atlas");

      for (const name of ["", "   ", 42, "x".repeat(101)]) {
        expect((await desktopApi("PATCH", `/api/groups/${room.id}`, { name })).status).toBe(400);
      }

      const state = (await api("GET", "/api/bots")).body;
      expect(state.groups.find((group: { id: string }) => group.id === room.id).name).toBe("Project Atlas");
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("gates Telegram pairing and token changes behind desktop authority and explicit revocation", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      // Telegram pairs only with the current workspace Chief; a fresh bot is not one.
      expect((await desktopApi("POST", "/api/telegram/pair", { targetBotId: bot.id })).status).toBe(409);
      const promoted = await desktopApi("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: true, chiefScope: "workspace" });
      expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
      expect((await api("GET", "/api/telegram/status")).status).toBe(404);
      expect((await desktopApi("PATCH", "/api/config", { telegram: { botToken: "123:abcdefghijklmnopqrstuvwxyz123456" } })).status).toBe(200);
      const pair = await desktopApi("POST", "/api/telegram/pair", { targetBotId: bot.id });
      expect(pair.status).toBe(200);
      expect(pair.body.code).toMatch(/^[a-f0-9]{64}$/);
      const status = await desktopApi("GET", "/api/telegram/status");
      expect(status.body).toMatchObject({ configured: true, enabled: true, paired: false, targetBotId: bot.id });
      expect(JSON.stringify(status.body)).not.toContain(pair.body.code);
      expect((await desktopApi("PATCH", "/api/config", { telegram: { botToken: "" } })).status).toBe(409);
      expect((await desktopApi("POST", "/api/telegram/revoke")).status).toBe(200);
      expect((await desktopApi("GET", "/api/telegram/status")).body.enabled).toBe(false);
      expect((await desktopApi("PATCH", "/api/config", { telegram: { botToken: "" } })).status).toBe(200);
    } finally {
      await desktopApi("POST", "/api/telegram/revoke");
      await desktopApi("PATCH", "/api/config", { telegram: { botToken: "", targetBotId: "" } });
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("refuses leadership on an incapable engine without persisting other changes", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Capability fixture", modelSelection: STATE_ONLY_SELECTION })).body.bot;
    try {
      for (const scope of ["section", "workspace"]) {
        const denied = await desktopApi("PATCH", `/api/bots/${bot.id}`, { name: "Must not save", chiefOfStaff: true, chiefScope: scope, individual: false });
        expect(denied.status).toBe(409);
        expect(denied.body.error).toMatch(/coordinate bots|already Chief/);
        const current = (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === bot.id);
        expect(current.name).toBe("Capability fixture"); expect(current.chiefOfStaff).toBe(bot.chiefOfStaff);
        expect(current.modelSelection).toEqual(STATE_ONLY_SELECTION);
      }
    } finally { await desktopApi("DELETE", `/api/bots/${bot.id}`); }
  });

  it("permits capable leadership and explicit demotion but blocks an incapable engine switch", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Capable leader fixture" })).body.bot;
    try {
      const promoted = await desktopApi("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: true, chiefScope: "section", individual: false, section: "Capability fixture team" });
      expect(promoted.status).toBe(200);
      expect(promoted.body.bot.chiefOfStaff).toBe(true);
      const denied = await desktopApi("PATCH", `/api/bots/${bot.id}`, { name: "Must not switch", modelSelection: STATE_ONLY_SELECTION });
      expect(denied.status).toBe(409); expect(denied.body.error).toContain("coordinate bots");
      const current = (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === bot.id);
      expect(current.name).toBe("Capable leader fixture"); expect(current.modelSelection).toEqual(bot.modelSelection);
      const demoted = await desktopApi("PATCH", `/api/bots/${bot.id}`, { chiefOfStaff: false, chiefScope: null, individual: false, modelSelection: STATE_ONLY_SELECTION });
      expect(demoted.status).toBe(200); expect(demoted.body.bot.chiefOfStaff).toBe(false);
    } finally { await desktopApi("DELETE", `/api/bots/${bot.id}`); }
  });

  it("distinguishes persistent agents capability revocation from transport loss and recovers on a fresh turn", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "MCP lifecycle fixture" })).body.bot;
    const clients: ReturnType<typeof persistentAgentsClient>[] = [];
    // Own the port throughout the negative control: reject connections without
    // routing any metadata request to a provider or another local service.
    const unavailable = createServer();
    unavailable.on("connection", socket => socket.destroy());
    await new Promise<void>(resolve => unavailable.listen(0, "127.0.0.1", resolve));
    const connect = async (env: Record<string, string>) => {
      const client = persistentAgentsClient(env); clients.push(client);
      await client.initialize(); return client;
    };
    const localMethodsWork = async (client: ReturnType<typeof persistentAgentsClient>) => {
      expect(await client.request("ping")).toEqual({});
      const catalog = await client.request("tools/list");
      expect(catalog.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(["list_bots", "list_image_models"]));
      expect(client.child.exitCode).toBeNull(); expect(client.child.signalCode).toBeNull();
    };
    const metadataWorks = async (client: ReturnType<typeof persistentAgentsClient>) => {
      for (const tool of ["list_bots", "list_image_models"] as const) {
        const result = await client.call(tool);
        expect(result.isError).toBe(false);
        expect(result.content?.[0]?.type).toBe("text");
      }
    };
    try {
      const first = await startInternalFixtureTurn(bot.id);
      const original = await connect(first.env), originalPid = original.child.pid;
      await localMethodsWork(original); await metadataWorks(original);
      // Let the fake engine complete normally, exercising terminal-event
      // revocation rather than manufacturing a token or touching live state.
      writeFileSync(join(home, "finish-fake", String(first.dump.pid)), "finish");
      await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots
        .find((entry: { id: string }) => entry.id === bot.id)?.busy, { timeout: 5_000 }).toBe(false);
      for (const path of ["/api/internal/agents", "/api/internal/image-models"]) {
        const response = await fetch(BASE + path, { headers: first.headers });
        expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "unauthorized" });
      }
      for (const tool of ["list_bots", "list_image_models"] as const) {
        expect(await original.call(tool)).toEqual({ isError: true, content: [{ type: "text", text: "unauthorized" }] });
      }
      await localMethodsWork(original); expect(original.child.pid).toBe(originalPid);
      const second = await startInternalFixtureTurn(bot.id);
      expect(second.env.MURAGE_COMMS_TOKEN === first.env.MURAGE_COMMS_TOKEN).toBe(false);
      const fresh = await connect(second.env);
      await localMethodsWork(fresh); await metadataWorks(fresh);
      // A new authority does not reauthorize the old, still-running proxy.
      expect((await original.call("list_bots")).isError).toBe(true);
      const disconnected = await connect({ ...second.env,
        MURAGE_HARNESS_URL: `http://127.0.0.1:${(unavailable.address() as { port: number }).port}` });
      for (const tool of ["list_bots", "list_image_models"] as const) {
        const result = await disconnected.call(tool);
        expect(result.isError).toBe(true);
        expect(result.content?.[0]?.text).toMatch(/^MURAGE_AGENTS_UNAVAILABLE:/);
      }
      await localMethodsWork(disconnected);
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await new Promise<void>((resolve, reject) => unavailable.close(error => error ? reject(error) : resolve()));
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 30_000);

  it("routes approved image MCP requests into owned artifacts without exposing keys or crossing conversations", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Image fixture" })).body.bot;
    const receipt = join(home, "image-fixture-calls.json"); rmSync(receipt, { force: true });
    const imageCall = (env: Record<string,string>, args: Record<string,unknown>) => {
      const proxy = spawn(process.execPath, [join(SERVER_DIR,"drivers","agents-proxy.ts")], { env: { PATH: process.env.PATH, ...env }, stdio:["pipe","pipe","pipe"] });
      let stdout="", stderr="";
      const result = new Promise<any>((resolve,reject)=>{
        const timer=setTimeout(()=>{proxy.kill();reject(new Error("Image MCP timed out: "+stderr));},15000);
        proxy.stderr.on("data",chunk=>{stderr+=chunk;});
        proxy.stdout.on("data",chunk=>{stdout+=chunk;for(const line of stdout.split("\n")){try{const value=JSON.parse(line);if(value.id===42){clearTimeout(timer);proxy.stdin.end();resolve(value.result);return;}}catch{}}});
        proxy.on("error",reject);
      });
      proxy.stdin.write(JSON.stringify({jsonrpc:"2.0",id:42,method:"tools/call",params:{name:"generate_image",arguments:args}})+"\n");
      return {proxy,result};
    };
    const pendingCard = async () => { let card:any; await expect.poll(async()=>{const state=(await api("GET","/api/bots?messages=100")).body.bots.find((b:any)=>b.id===bot.id);card=state.messages.find((m:any)=>m.card?.tool==="generate_image"&&!m.card.answered);return Boolean(card);}).toBe(true);return card; };
    const proxies: ReturnType<typeof imageCall>["proxy"][]=[];
    let stream: Awaited<ReturnType<typeof openSse>> | undefined;
    try {
      expect((await api("GET","/api/images/settings")).status).toBe(404);
      expect((await desktopApi("PATCH","/api/config?secretStorage=external",{imageGen:{key:"fixture-image-key"}})).status).toBe(200);
      const settings = await desktopApi("POST","/api/images/settings",{enabled:true,connectionId:"openai",model:"gpt-image-2"});
      expect(settings.status).toBe(200);expect(settings.body.selected).toEqual({connectionId:"openai",model:"gpt-image-2"});
      expect(JSON.stringify(settings.body)).not.toContain("fixture-image-key");expect(readFileSync(join(home,".murage","config.json"),"utf8")).not.toContain("fixture-image-key");
      let turn=await startInternalFixtureTurn(bot.id);
      // 0.1.54: an image card is an approval like any other — it buzzes the
      // owner, flips the task to "waiting for you", and waits for an answer.
      stream=await openSse(`${BASE}/api/events`);await stream.until(frame=>frame.kind==="hello");
      const denied=imageCall(turn.env,{request_id:"deny",prompt:"Synthetic image fixture"});proxies.push(denied.proxy);
      let card=await pendingCard();expect(existsSync(receipt)).toBe(false);
      const buzz=await stream.until(frame=>frame.kind==="notify"&&frame.notification?.requestId===card.card.requestId,10_000);
      expect(buzz.notification).toMatchObject({kind:"approval",botId:bot.id,threadId:bot.threadId,messageId:card.id});
      expect(buzz.notification.body).toContain("gpt-image-2");
      await expect.poll(async()=>(await api("GET","/api/bots?messages=0")).body.bots.find((b:any)=>b.id===bot.id).activity).toBe("waiting-on-you");
      expect((await desktopApi("POST",`/api/bots/${bot.id}/respond`,{requestId:card.card.requestId,behavior:"deny"})).status).toBe(200);
      expect((await denied.result).isError).toBe(true);expect(existsSync(receipt)).toBe(false);
      // A second answer to a card the owner already settled (double click, or
      // the Inbox copy) is not a failure: no "Couldn't deliver" chip.
      const repeated=await desktopApi("POST",`/api/bots/${bot.id}/respond`,{requestId:card.card.requestId,behavior:"deny"});
      expect(repeated.status).toBe(200);expect(repeated.body.outcome).toBe("rejected");
      expect((await api("GET","/api/bots?messages=100")).body.bots.find((b:any)=>b.id===bot.id).messages.some((m:any)=>String(m.tool?.name??"").startsWith("Couldn't deliver"))).toBe(false);
      const deniedCard=(await api("GET","/api/bots?messages=100")).body.bots.find((b:any)=>b.id===bot.id).messages.find((m:any)=>m.id===card.id);
      expect(deniedCard.card).toMatchObject({answered:"deny",dismissed:false});
      await expect.poll(async()=>(await api("GET","/api/bots?messages=0")).body.bots.find((b:any)=>b.id===bot.id).activity).not.toBe("waiting-on-you");
      await stopFixtureTurn(bot.id,turn);
      turn=await startInternalFixtureTurn(bot.id);
      const args={request_id:"generate",prompt:"Synthetic image fixture",connection_id:"openai",model:"gpt-image-2"};
      const generated=imageCall(turn.env,args);proxies.push(generated.proxy);card=await pendingCard();
      expect(card.card.subtitle).toContain("gpt-image-2");expect(existsSync(receipt)).toBe(false);
      expect((await desktopApi("POST",`/api/bots/${bot.id}/respond`,{requestId:card.card.requestId,behavior:"allow"})).status).toBe(200);
      const result=await generated.result;expect(result.isError).not.toBe(true);
      const payload=JSON.parse(result.content[0].text);expect(payload.metadata.model).toBe("gpt-image-2");expect(existsSync(payload.artifact.path)).toBe(true);
      expect(payload.artifact.path).toContain(join("workspaces",bot.id,"generated-images"));
      expect(JSON.stringify(payload)).not.toContain("fixture-image-key");expect(JSON.parse(readFileSync(receipt,"utf8"))).toMatchObject({calls:1,model:"gpt-image-2",n:1,references:0});
      const repeat=imageCall(turn.env,args);proxies.push(repeat.proxy);expect(JSON.parse((await repeat.result).content[0].text).artifact.id).toBe(payload.artifact.id);
      expect(JSON.parse(readFileSync(receipt,"utf8")).calls).toBe(1);
      await stopFixtureTurn(bot.id,turn);
      expect((await fetch(`${BASE}/api/internal/image-models`,{headers:turn.headers})).status).toBe(401);
      turn=await startInternalFixtureTurn(bot.id);
      const edit=imageCall(turn.env,{request_id:"edit",prompt:"Edit the synthetic fixture",operation:"edit",reference_ids:[payload.artifact.referenceId]});proxies.push(edit.proxy);
      card=await pendingCard();expect(card.card.title).toBe("Approve image edit");
      await desktopApi("POST",`/api/bots/${bot.id}/respond`,{requestId:card.card.requestId,behavior:"allow"});
      expect((await edit.result).isError).not.toBe(true);expect(JSON.parse(readFileSync(receipt,"utf8"))).toMatchObject({calls:2,references:1});
    } finally {
      stream?.close();
      await api("POST",`/api/bots/${bot.id}/interrupt`);for(const proxy of proxies)if(proxy.exitCode===null)await waitForExit(proxy,{signal:"SIGTERM"});
      await desktopApi("PATCH","/api/config",{imageGen:{key:"",enabled:false}});await desktopApi("DELETE",`/api/bots/${bot.id}`);
    }
  }, 40000);

  it("routes approved xAI and OpenRouter reference edits to their own origins with exact source bytes and a pinned endpoint", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Image provider fixture" })).body.bot;
    const receipt = join(home, "image-fixture-calls.json"); rmSync(receipt, { force: true });
    const lastCall = () => JSON.parse(readFileSync(receipt, "utf8"));
    const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const proxies: ReturnType<typeof spawn>[] = [];
    const imageCall = (env: Record<string,string>, args: Record<string,unknown>) => {
      const proxy = spawn(process.execPath, [join(SERVER_DIR,"drivers","agents-proxy.ts")], { env: { PATH: process.env.PATH, ...env }, stdio:["pipe","pipe","pipe"] });
      proxies.push(proxy);
      let stdout="", stderr="";
      const result = new Promise<any>((resolve,reject)=>{
        const timer=setTimeout(()=>{proxy.kill();reject(new Error("Image MCP timed out: "+stderr));},15000);
        proxy.stderr.on("data",chunk=>{stderr+=chunk;});
        proxy.stdout.on("data",chunk=>{stdout+=chunk;for(const line of stdout.split("\n")){try{const value=JSON.parse(line);if(value.id===42){clearTimeout(timer);proxy.stdin.end();resolve(value.result);return;}}catch{}}});
        proxy.on("error",reject);
      });
      proxy.stdin.write(JSON.stringify({jsonrpc:"2.0",id:42,method:"tools/call",params:{name:"generate_image",arguments:args}})+"\n");
      return result;
    };
    const approved = async (pending: Promise<any>) => {
      let card:any;
      await expect.poll(async()=>{const state=(await api("GET","/api/bots?messages=100")).body.bots.find((b:any)=>b.id===bot.id);card=state.messages.find((m:any)=>m.card?.tool==="generate_image"&&!m.card.answered);return Boolean(card);}).toBe(true);
      expect((await desktopApi("POST",`/api/bots/${bot.id}/respond`,{requestId:card.card.requestId,behavior:"allow"})).status).toBe(200);
      const result=await pending;expect(result.isError).not.toBe(true);
      return { card, payload: JSON.parse(result.content[0].text) };
    };
    try {
      expect((await desktopApi("PATCH","/api/config?secretStorage=external",{xai:{key:"xai-fixture-image-key"},openaiCompat:{key:"sk-or-fixture-image-key",url:"https://openrouter.ai/api/v1"}})).status).toBe(200);
      const xaiSettings = await desktopApi("POST","/api/images/settings",{enabled:true,connectionId:"xai",model:"grok-imagine-image-2.0"});
      expect(xaiSettings.status).toBe(200);
      expect(xaiSettings.body.catalog.models).toEqual([expect.objectContaining({id:"grok-imagine-image-2.0",generate:true,edit:true,maxReferences:4,editQualities:[]})]);

      let turn = await startInternalFixtureTurn(bot.id);
      const source = await approved(imageCall(turn.env,{request_id:"xai-source",prompt:"Synthetic source",connection_id:"xai",model:"grok-imagine-image-2.0"}));
      // The fixture counter is shared by the whole server process, so count from this test's first POST.
      const firstCall = lastCall().calls as number;
      expect(lastCall()).toMatchObject({provider:"xai",url:"https://api.x.ai/v1/images/generations",references:0,quality:"low",responseFormat:"b64_json"});
      await stopFixtureTurn(bot.id,turn);

      // xAI: JSON edit with the `image` field carrying the exact attachment bytes, no quality.
      turn = await startInternalFixtureTurn(bot.id);
      const xaiEdit = await approved(imageCall(turn.env,{request_id:"xai-edit",prompt:"Edit the synthetic source",operation:"edit",connection_id:"xai",model:"grok-imagine-image-2.0",reference_ids:[source.payload.artifact.referenceId]}));
      expect(xaiEdit.card.card.title).toBe("Approve image edit");
      expect(lastCall()).toEqual({calls:firstCall+1,url:"https://api.x.ai/v1/images/edits",provider:"xai",model:"grok-imagine-image-2.0",n:1,references:1,referenceHashes:[sha256(source.payload.artifact.path)],
        quality:null,responseFormat:"b64_json",providerRouting:null,singleImageField:true,multiImageField:false,redirect:"error"});
      expect(xaiEdit.payload.metadata).toMatchObject({provider:"xai",operation:"edit",referenceCount:1});
      await stopFixtureTurn(bot.id,turn);

      // OpenRouter: editing is offered only after the pinned endpoint check.
      const openRouterSettings = await desktopApi("POST","/api/images/settings",{enabled:true,connectionId:"openrouter",model:"openai/gpt-image-2"});
      expect(openRouterSettings.status).toBe(200);
      expect(openRouterSettings.body.catalog.models).toEqual([expect.objectContaining({id:"openai/gpt-image-2",generate:true,edit:true,maxReferences:16})]);
      turn = await startInternalFixtureTurn(bot.id);
      const openRouterArgs = {request_id:"openrouter-edit",prompt:"Combine the synthetic sources",operation:"edit",connection_id:"openrouter",model:"openai/gpt-image-2",reference_ids:[source.payload.artifact.referenceId,xaiEdit.payload.artifact.referenceId]};
      const openRouterEdit = await approved(imageCall(turn.env,openRouterArgs));
      expect(lastCall()).toEqual({calls:firstCall+2,url:"https://openrouter.ai/api/v1/images",provider:"openrouter",model:"openai/gpt-image-2",n:1,references:2,
        referenceHashes:[sha256(source.payload.artifact.path),sha256(xaiEdit.payload.artifact.path)],quality:null,responseFormat:null,
        providerRouting:{only:["openai"],allow_fallbacks:false},singleImageField:false,multiImageField:false,redirect:"error"});
      expect(openRouterEdit.payload.metadata).toMatchObject({provider:"openrouter",operation:"edit",referenceCount:2,endpointTag:"openai",upstreamProvider:"openai"});
      // The endpoint identity is kept in the stored operation result: a duplicate returns it without a second POST.
      const repeated = JSON.parse((await imageCall(turn.env,openRouterArgs)).content[0].text);
      expect(repeated.artifact.id).toBe(openRouterEdit.payload.artifact.id);expect(repeated.metadata.endpointTag).toBe("openai");expect(lastCall().calls).toBe(firstCall+2);
      expect(JSON.stringify([source,xaiEdit,openRouterEdit,repeated])).not.toMatch(/fixture-image-key/);
    } finally {
      await api("POST",`/api/bots/${bot.id}/interrupt`);for(const proxy of proxies)if(proxy.exitCode===null)await waitForExit(proxy,{signal:"SIGTERM"});
      await desktopApi("PATCH","/api/config",{imageGen:{enabled:false},xai:{key:""},openaiCompat:{key:"",url:""}});await desktopApi("DELETE",`/api/bots/${bot.id}`);
    }
  }, 40000);

  // F5-T4 (IMG-SEED): an uploaded image, a previously generated image and an
  // authorized workspace image reach the provider as their exact bytes through
  // one reference flow. A failed source prepares nothing and bills nothing;
  // the edited result lands in Files.
  it("edits from uploaded, generated and workspace reference images with exact bytes and nothing prepared on failure", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Reference fixture" })).body.bot;
    const receipt = join(home, "image-fixture-calls.json");
    const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const proxies: ChildProcess[] = [];
    const mcp = (env: Record<string, string>, name: string, args: Record<string, unknown>) => {
      const proxy = spawn(process.execPath, [join(SERVER_DIR, "drivers", "agents-proxy.ts")], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      proxies.push(proxy);
      let stdout = "", stderr = "";
      const result = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { proxy.kill(); reject(new Error(`${name} timed out: ${stderr}`)); }, 15_000);
        proxy.stderr.on("data", chunk => { stderr += chunk; });
        proxy.stdout.on("data", chunk => {
          stdout += chunk;
          for (const line of stdout.split("\n")) { try { const value = JSON.parse(line); if (value.id === 42) { clearTimeout(timer); proxy.stdin.end(); resolve(value.result); return; } } catch {} }
        });
        proxy.on("error", reject);
      });
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name, arguments: args } }) + "\n");
      return result;
    };
    const messages = async () => (await api("GET", "/api/bots?messages=100")).body.bots.find((item: { id: string }) => item.id === bot.id).messages as any[];
    const pendingCard = async () => { let card: any; await expect.poll(async () => { card = (await messages()).find(m => m.card?.tool === "generate_image" && !m.card.answered); return Boolean(card); }).toBe(true); return card; };
    const calls = () => existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")).calls as number : 0;
    const fixturePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
    try {
      expect((await desktopApi("PATCH", "/api/config?secretStorage=external", { imageGen: { key: "fixture-image-key" } })).status).toBe(200);
      expect((await desktopApi("POST", "/api/images/settings", { enabled: true, connectionId: "openai", model: "gpt-image-2" })).status).toBe(200);
      // A previously generated image of this conversation.
      let turn = await startInternalFixtureTurn(bot.id);
      const source = mcp(turn.env, "generate_image", { request_id: "seed-source", prompt: "Synthetic source", connection_id: "openai", model: "gpt-image-2" });
      let card = await pendingCard();
      expect((await desktopApi("POST", `/api/bots/${bot.id}/respond`, { requestId: card.card.requestId, behavior: "allow" })).status).toBe(200);
      const generated = JSON.parse((await source).content[0].text).artifact;
      await stopFixtureTurn(bot.id, turn);
      // An owner-authorized workspace image in this task's own workspace, as
      // the server itself resolves that folder.
      const folder = await desktopApi("GET", `/api/artifacts/workspace?botId=${bot.id}&threadId=${bot.threadId}`);
      expect(folder.status).toBe(200);
      const workspace = folder.body.path as string;
      const workspaceBytes = Buffer.concat([fixturePng, Buffer.from("workspace reference")]);
      mkdirSync(join(workspace, "refs"), { recursive: true }); writeFileSync(join(workspace, "refs", "layout.png"), workspaceBytes);
      // An image the person uploads with their message.
      const uploadBytes = Buffer.concat([fixturePng, Buffer.from("uploaded reference")]);
      const upload = await fetch(`${BASE}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: uploadBytes });
      expect(upload.status).toBe(201);
      const uploadPath = ((await upload.json()) as { path: string }).path;
      turn = await startInternalFixtureTurn(bot.id, undefined, `Use my sketch\n\n<attached-image path="${uploadPath}" />`);
      const uploadId = uploadPath.split(/[\\/]/).at(-1)!;
      const before = { calls: calls(), messages: (await messages()).length };

      // One missing source prepares nothing, asks for no approval and bills nothing.
      const failed = await mcp(turn.env, "resolve_image_reference", { sources: [{ attachment_id: uploadId }, { relative_path: "refs/absent.png" }] });
      expect(failed.isError).toBe(true); expect(failed.content[0].text).toContain("No reference image was prepared");
      expect((await messages()).length).toBe(before.messages); expect(calls()).toBe(before.calls);

      const resolved = await mcp(turn.env, "resolve_image_reference", { sources: [{ attachment_id: uploadId }, { attachment_id: generated.referenceId }, { relative_path: "refs/layout.png" }] });
      expect(resolved.isError, resolved.content?.[0]?.text).not.toBe(true);
      const references = JSON.parse(resolved.content[0].text).references as Array<{ id: string; sha256: string; source: string }>;
      expect(references.map(ref => ref.sha256)).toEqual([sha256(uploadBytes), sha256(readFileSync(generated.path)), sha256(workspaceBytes)]);
      expect(references.slice(0, 2).map(ref => ref.id)).toEqual([uploadId, generated.referenceId]);
      const disclosure = (await messages()).at(-1);
      expect(disclosure.text).toContain("refs/layout.png"); expect(disclosure.text).toContain("Nothing is generated until you approve");
      expect(JSON.stringify(references)).not.toContain(workspace);
      expect(calls()).toBe(before.calls);

      // The edit names its reference count before approval; the provider then
      // receives the three original byte sequences, and the result is in Files.
      const edit = mcp(turn.env, "generate_image", { request_id: "seed-edit", prompt: "Combine the references", operation: "edit", reference_ids: references.map(ref => ref.id) });
      card = await pendingCard();
      expect(card.card.title).toBe("Approve image edit"); expect(card.card.subtitle).toContain("One image from 3 reference images");
      expect(calls()).toBe(before.calls);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/respond`, { requestId: card.card.requestId, behavior: "allow" })).status).toBe(200);
      const edited = await edit; expect(edited.isError).not.toBe(true);
      const payload = JSON.parse(edited.content[0].text);
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ calls: before.calls + 1, url: "https://api.openai.com/v1/images/edits", references: 3,
        referenceHashes: [sha256(uploadBytes), sha256(readFileSync(generated.path)), sha256(workspaceBytes)] });
      expect(payload.metadata).toMatchObject({ operation: "edit", referenceCount: 3 });
      expect(payload.artifact.artifactId).toEqual(expect.any(String));
      const files = await desktopApi("GET", `/api/artifacts?botId=${bot.id}&kind=image`);
      expect(files.body.items.map((item: { id: string }) => item.id)).toContain(payload.artifact.artifactId);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`); for (const proxy of proxies) if (proxy.exitCode === null) await waitForExit(proxy, { signal: "SIGTERM" });
      await desktopApi("PATCH", "/api/config", { imageGen: { key: "", enabled: false } }); await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 40_000);

  // Image generation v2 A.2 / A.6: a bot saves a prompt block and a reference
  // pack in its own scope, generates from them with no scene, and the card
  // names the block version, the assembled length and the pack. The owner
  // sees both in the library, with the bot's name, and deletes them.
  // A.8: the owner's "Check this model now" runs one small render that is
  // never published, marks the model verified with the time, and the daily
  // check stays off until the owner turns it on.
  it("checks a model for the owner without publishing anything, and keeps the daily check off by default", async () => {
    try {
      expect((await desktopApi("PATCH", "/api/config?secretStorage=external", { imageGen: { key: "fixture-image-key" } })).status).toBe(200);
      const settings = await desktopApi("POST", "/api/images/settings", { enabled: true, connectionId: "openai", model: "gpt-image-2" });
      expect(settings.body.dailyProbe).toBe(false);
      expect(settings.body.catalog.models.find((model: { id: string }) => model.id === "gpt-image-2").availability).toBe("unverified");
      const bots = (await api("GET", "/api/bots?messages=100")).body.bots as Array<{ messages: unknown[] }>;
      const messagesBefore = bots.reduce((sum, item) => sum + item.messages.length, 0);
      // Without the desktop's own proof a local process gets nothing: no check, no library.
      expect((await api("POST", "/api/images/probe", { connectionId: "openai", model: "gpt-image-2" })).status).toBe(404);
      expect((await api("GET", "/api/images/library")).status).toBe(404);
      expect((await api("POST", "/api/images/prompt-blocks", { name: "sneaky", text: "x" })).status).toBe(404);
      const checked = await desktopApi("POST", "/api/images/probe", { connectionId: "openai", model: "gpt-image-2" });
      expect(checked.status).toBe(200);
      expect(checked.body.probe).toMatchObject({ ok: true, free: false });
      const model = checked.body.settings.catalog.models.find((item: { id: string }) => item.id === "gpt-image-2");
      expect(model).toMatchObject({ availability: "verified", lastGoodAt: expect.any(Number) });
      const after = (await api("GET", "/api/bots?messages=100")).body.bots as Array<{ messages: unknown[] }>;
      expect(after.reduce((sum, item) => sum + item.messages.length, 0)).toBe(messagesBefore);
      expect((await desktopApi("POST", "/api/images/settings", { dailyProbe: true })).body.dailyProbe).toBe(true);
    } finally {
      await desktopApi("PATCH", "/api/config", { imageGen: { key: "", enabled: false, dailyProbe: false } });
    }
  }, 40_000);

  it("saves prompt blocks and reference packs for a bot and generates from them", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Library fixture" })).body.bot;
    const proxies: ChildProcess[] = [];
    const mcp = (env: Record<string, string>, name: string, args: Record<string, unknown>) => {
      const proxy = spawn(process.execPath, [join(SERVER_DIR, "drivers", "agents-proxy.ts")], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      proxies.push(proxy);
      let stdout = "", stderr = "";
      const result = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { proxy.kill(); reject(new Error(`${name} timed out: ${stderr}`)); }, 15_000);
        proxy.stderr.on("data", chunk => { stderr += chunk; });
        proxy.stdout.on("data", chunk => {
          stdout += chunk;
          for (const line of stdout.split("\n")) { try { const value = JSON.parse(line); if (value.id === 42) { clearTimeout(timer); proxy.stdin.end(); resolve(value.result); return; } } catch {} }
        });
        proxy.on("error", reject);
      });
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name, arguments: args } }) + "\n");
      return result;
    };
    const messages = async () => (await api("GET", "/api/bots?messages=100")).body.bots.find((item: { id: string }) => item.id === bot.id).messages as any[];
    const pendingCard = async () => { let card: any; await expect.poll(async () => { card = (await messages()).find(m => m.card?.tool === "generate_image" && !m.card.answered); return Boolean(card); }).toBe(true); return card; };
    const lock = "Identity: a red fox mascot with a blue scarf, flat colour.";
    try {
      expect((await desktopApi("PATCH", "/api/config?secretStorage=external", { imageGen: { key: "fixture-image-key" } })).status).toBe(200);
      expect((await desktopApi("POST", "/api/images/settings", { enabled: true, connectionId: "openai", model: "gpt-image-2" })).status).toBe(200);
      let turn = await startInternalFixtureTurn(bot.id);
      const saved = JSON.parse((await mcp(turn.env, "save_prompt_block", { name: "brand-lock", text: lock })).content[0].text);
      expect(saved).toMatchObject({ name: "brand-lock", version: 1, chars: lock.length, scope: "bot" });
      const listed = JSON.parse((await mcp(turn.env, "list_prompt_blocks", {})).content[0].text);
      expect(listed.blocks).toEqual([expect.objectContaining({ name: "brand-lock", version: 1, preview: lock })]);
      const generated = mcp(turn.env, "generate_image", { request_id: "from-block", prompt_blocks: ["brand-lock"], connection_id: "openai", model: "gpt-image-2" });
      const card = await pendingCard();
      expect(card.card.subtitle).toContain(`Prompt: ${lock.length} characters: brand-lock v1.`);
      expect(card.card.held).toBe(lock);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/respond`, { requestId: card.card.requestId, behavior: "allow" })).status).toBe(200);
      const result = await generated; expect(result.isError, result.content?.[0]?.text).not.toBe(true);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.metadata).toMatchObject({ promptChars: lock.length, promptBlocks: [{ name: "brand-lock", version: 1, scope: "bot" }] });
      expect(result.content[0].text).not.toContain("red fox");
      const pack = JSON.parse((await mcp(turn.env, "save_reference_pack", { name: "hero-refs", reference_ids: [payload.artifact.referenceId] })).content[0].text);
      expect(pack).toMatchObject({ name: "hero-refs", version: 1, count: 1, scope: "bot" });
      const missing = await mcp(turn.env, "get_prompt_block", { name: "not-saved" });
      expect(missing.isError).toBe(true);
      await stopFixtureTurn(bot.id, turn);
      turn = await startInternalFixtureTurn(bot.id);
      const edit = mcp(turn.env, "generate_image", { request_id: "from-pack", prompt: "Same mascot, waving.", reference_pack: "hero-refs", connection_id: "openai", model: "gpt-image-2" });
      const editCard = await pendingCard();
      expect(editCard.card.title).toBe("Approve image edit");
      expect(editCard.card.subtitle).toContain("References: 1 from pack hero-refs v1 + 0 attached = 1 of 16.");
      expect((await desktopApi("POST", `/api/bots/${bot.id}/respond`, { requestId: editCard.card.requestId, behavior: "deny" })).status).toBe(200);
      expect((await edit).isError).toBe(true);
      const library = await desktopApi("GET", "/api/images/library");
      expect(library.body.blocks).toEqual([expect.objectContaining({ name: "brand-lock", version: 1, chars: lock.length, scope: "bot", botName: "Library fixture" })]);
      expect(library.body.packs).toEqual([expect.objectContaining({ name: "hero-refs", count: 1, botName: "Library fixture" })]);
      const read = await desktopApi("GET", `/api/images/prompt-blocks/${library.body.blocks[0].id}`);
      expect(read.body.block.text).toBe(lock);
      const newer = await desktopApi("POST", "/api/images/prompt-blocks", { name: "brand-lock", text: `${lock} Always smiling.`, botId: bot.id });
      expect(newer.status).toBe(201); expect(newer.body.block).toMatchObject({ version: 2, scope: "bot" });
      expect((await desktopApi("DELETE", `/api/images/prompt-blocks/${newer.body.block.id}`)).body.deleted).toEqual({ name: "brand-lock", versions: 2 });
      expect((await desktopApi("DELETE", `/api/images/reference-packs/${library.body.packs[0].id}`)).status).toBe(200);
      expect((await desktopApi("GET", "/api/images/library")).body).toEqual({ blocks: [], packs: [] });
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`); for (const proxy of proxies) if (proxy.exitCode === null) await waitForExit(proxy, { signal: "SIGTERM" });
      await desktopApi("PATCH", "/api/config", { imageGen: { key: "", enabled: false } }); await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 40_000);

  // An <attached-image path> the conversation never bound — the legacy upload
  // the composer makes without a thread — must not lose the turn on an engine
  // that inlines. Nothing is inlined for it (the tag never grants a read), the
  // tag stays in the text as it always did, and the bot is told it has a path.
  // A bound upload on the same engine is the positive half: the bytes ride the
  // prompt and the bot is told the picture is in front of it.
  it("carries an unbound image as a path on an inline engine, and inlines a bound one", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Unbound image fixture" })).body.bot;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
    const dump = () => readJsonFileWhenReady<{ prompt: { message: { content: unknown } }; systemPrompt: string | null }>(fakeClaudeDump);
    try {
      const unbound = await fetch(`${BASE}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
      expect(unbound.status).toBe(201);
      const unboundPath = ((await unbound.json()) as { path: string }).path;
      await startInternalFixtureTurn(bot.id, undefined, `What is this?\n\n<attached-image path="${unboundPath}" />`);
      const degraded = await dump();
      // The whole turn reached the engine, the tag as text, no bytes beside it.
      expect(typeof degraded.prompt.message.content).toBe("string");
      expect(degraded.prompt.message.content).toContain(`<attached-image path="${unboundPath}" />`);
      expect(JSON.stringify(degraded.prompt)).not.toContain(png.toString("base64"));
      // The user message recorded the truth: nothing bound.
      const thread = (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: { id: string }) => candidate.id === bot.id).threadId;
      const recorded = ((await api("GET", `/api/threads/${thread}/messages`)).body.messages as Array<{ role: string; text?: string; attachments?: unknown[] }>)
        .find((message) => message.role === "user" && message.text?.includes(unboundPath));
      expect(recorded?.attachments).toEqual([]);
      // And the bot was told it has a path, never that a picture is in front of it.
      expect(degraded.systemPrompt).toMatch(/open that path with your file-read tool/);
      expect(degraded.systemPrompt).not.toMatch(/[Ii]mages attached to this turn are already in front of you/);
      await api("POST", `/api/bots/${bot.id}/interrupt`);

      const bound = await fetch(`${BASE}/api/attachments?threadId=${encodeURIComponent(thread)}`, { method: "POST", headers: { ...DESKTOP_HEADERS, "content-type": "image/png" }, body: png });
      expect(bound.status).toBe(201);
      const boundPath = ((await bound.json()) as { path: string }).path;
      await startInternalFixtureTurn(bot.id, undefined, `And this?\n\n<attached-image path="${boundPath}" />`);
      const inlined = await dump();
      expect(inlined.prompt.message.content).toEqual([
        { type: "text", text: expect.stringContaining(`<attached-image path="${boundPath}" />`) },
        { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
      ]);
      expect(inlined.systemPrompt).toMatch(/Images attached to this turn are already in front of you/);
      expect(inlined.systemPrompt).not.toMatch(/open that path with your file-read tool/);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 40_000);

  // A room member's turn tells the bot what happened to an attached picture
  // the same way a direct turn does: in front of it when the room thread bound
  // the upload, a path to open when it did not.
  it("tells a room member whether an attached image is in front of it or only a path", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Room image fixture" })).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Room image fixture",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    })).body.group;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
    const systemPrompt = (dump: unknown) => String((dump as { systemPrompt?: string | null }).systemPrompt ?? "");
    try {
      const bound = await fetch(`${BASE}/api/attachments?threadId=${encodeURIComponent(room.threadId)}`, { method: "POST", headers: { ...DESKTOP_HEADERS, "content-type": "image/png" }, body: png });
      expect(bound.status).toBe(201);
      const boundPath = ((await bound.json()) as { path: string }).path;
      const inlined = await startInternalFixtureTurn(bot.id, room.id, `What is this?\n\n<attached-image path="${boundPath}" />`);
      expect(JSON.stringify(inlined.dump)).toContain(png.toString("base64"));
      expect(systemPrompt(inlined.dump)).toMatch(/Images attached to this turn are already in front of you/);
      expect(systemPrompt(inlined.dump)).not.toMatch(/open that path with your file-read tool/);
      expect((await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId })).status).toBe(200);

      const unbound = await fetch(`${BASE}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: png });
      expect(unbound.status).toBe(201);
      const unboundPath = ((await unbound.json()) as { path: string }).path;
      const degraded = await startInternalFixtureTurn(bot.id, room.id, `And this?\n\n<attached-image path="${unboundPath}" />`);
      // Matched inside the JSON dump, so the tag is JSON-escaped the same way
      // (a Windows path's backslashes are doubled there).
      expect(JSON.stringify(degraded.dump)).toContain(JSON.stringify(`<attached-image path="${unboundPath}" />`).slice(1, -1));
      expect(systemPrompt(degraded.dump)).toMatch(/open that path with your file-read tool/);
      expect(systemPrompt(degraded.dump)).not.toMatch(/[Ii]mages attached to this turn are already in front of you/);
    } finally {
      await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 40_000);

  // R3-T4: an approved generated image enters Files exactly once; repeating
  // the request returns the same saved result with no provider call.
  it("saves an approved generated image to Files once and repeats the request without provider work", async () => {
    const bot = (await desktopApi("POST", "/api/bots", { name: "Image Files fixture" })).body.bot;
    const receipt = join(home, "image-fixture-calls.json");
    const proxies: ChildProcess[] = [];
    const imageCall = (env: Record<string, string>, args: Record<string, unknown>) => {
      const proxy = spawn(process.execPath, [join(SERVER_DIR, "drivers", "agents-proxy.ts")], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
      proxies.push(proxy);
      let stdout = "", stderr = "";
      const result = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { proxy.kill(); reject(new Error("Image MCP timed out: " + stderr)); }, 15_000);
        proxy.stderr.on("data", chunk => { stderr += chunk; });
        proxy.stdout.on("data", chunk => {
          stdout += chunk;
          for (const line of stdout.split("\n")) { try { const value = JSON.parse(line); if (value.id === 42) { clearTimeout(timer); proxy.stdin.end(); resolve(value.result); return; } } catch {} }
        });
        proxy.on("error", reject);
      });
      proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "generate_image", arguments: args } }) + "\n");
      return result;
    };
    const messages = async () => (await api("GET", "/api/bots?messages=100")).body.bots.find((item: { id: string }) => item.id === bot.id).messages;
    try {
      expect((await desktopApi("PATCH", "/api/config?secretStorage=external", { imageGen: { key: "fixture-image-key" } })).status).toBe(200);
      expect((await desktopApi("POST", "/api/images/settings", { enabled: true, connectionId: "openai", model: "gpt-image-2" })).status).toBe(200);
      const turn = await startInternalFixtureTurn(bot.id);
      const args = { request_id: "files-once", prompt: "Synthetic Files image", connection_id: "openai", model: "gpt-image-2" };
      const first = imageCall(turn.env, args);
      let card: any;
      await expect.poll(async () => { card = (await messages()).find((message: any) => message.card?.tool === "generate_image" && !message.card.answered); return Boolean(card); }).toBe(true);
      expect((await desktopApi("POST", `/api/bots/${bot.id}/respond`, { requestId: card.card.requestId, behavior: "allow" })).status).toBe(200);
      const result = await first;
      expect(result.isError).not.toBe(true);
      const payload = JSON.parse(result.content[0].text);
      const calls = JSON.parse(readFileSync(receipt, "utf8")).calls;
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
      expect(payload.artifact.artifactId).toEqual(expect.any(String));
      const saved = await desktopApi("GET", `/api/artifacts/${payload.artifact.artifactId}`);
      expect(saved.body.artifact).toMatchObject({ kind: "image", producer: "image-operation", sha256: createHash("sha256").update(png).digest("hex"),
        threadId: bot.threadId, sourceConversationAvailable: true, relativePath: payload.artifact.path.split(/[\\/]/).at(-1) });
      expect((await desktopApi("GET", `/api/artifacts?botId=${bot.id}&kind=image`)).body.items.map((item: { id: string }) => item.id)).toEqual([payload.artifact.artifactId]);
      expect((await desktopApi("GET", `/api/artifacts/${payload.artifact.artifactId}/preview`)).body.content).toBe(`data:image/png;base64,${png.toString("base64")}`);
      const repeat = JSON.parse((await imageCall(turn.env, args)).content[0].text);
      expect(repeat.artifact).toEqual(payload.artifact);
      expect(JSON.parse(readFileSync(receipt, "utf8")).calls).toBe(calls);
      expect((await messages()).filter((message: { attachments?: unknown[] }) => message.attachments?.length)).toHaveLength(1);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      for (const proxy of proxies) if (proxy.exitCode === null) await waitForExit(proxy, { signal: "SIGTERM" });
      await desktopApi("PATCH", "/api/config", { imageGen: { key: "", enabled: false } });
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  }, 40_000);

  it("routes scoped native search without exposing credentials or allowing retired turns", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const requestFile = join(home, "search-fixture-calls.json");
    try {
      const turn = await startInternalFixtureTurn(bot.id);
      const body = { fromBotId: bot.id, fromThreadId: turn.env.MURAGE_THREAD_ID, query: "fixture search", maxResults: 2 };
      const search = (headers: Record<string, string> = turn.headers, requestBody = body) => fetch(`${BASE}/api/internal/web-search`, {
        method: "POST", headers, body: JSON.stringify(requestBody),
      });
      expect((await search({ "content-type": "application/json" })).status).toBe(401);
      await desktopApi("PATCH", "/api/config", { webSearch: { provider: "off" } });
      expect((await search()).status).toBe(409);
      expect(existsSync(requestFile)).toBe(false);
      await desktopApi("PATCH", "/api/config", { webSearch: { provider: "tavily", tavilyApiKey: "native-search-fixture-key" } });
      const result = await search();
      expect(result.status).toBe(200);
      const payload = await result.json();
      expect(payload).toMatchObject({ provider: "tavily", untrusted: true, results: [{ title: "Fixture source", url: "https://example.com/source", snippet: "Untrusted source excerpt." }] });
      expect(JSON.stringify(payload)).not.toContain("native-search-fixture-key");
      const sent = JSON.parse(readFileSync(requestFile, "utf8"));
      expect(sent).toMatchObject({ calls: 1, bearerPresent: true, redirect: "error", body: { query: "fixture search", max_results: 2 } });
      expect((await search(turn.headers, { ...body, fromBotId: "other-bot" })).status).toBe(403);
      expect((await search(turn.headers, { ...body, maxResults: 1000 })).status).toBe(400);
      expect((await desktopApi("PATCH", "/api/config", { webSearch: { provider: "auto" } })).status).toBe(200);
      const free = await search();
      expect(free.status).toBe(200);
      expect(await free.json()).toMatchObject({ provider: "parallel", fallbackUsed: false, untrusted: true,
        results: [{ title: "Free fixture source", url: "https://example.com/free" }] });
      // Flux search uses the Flux key saved under Models; with none it says
      // so rather than falling back to another service
      await desktopApi("PATCH", "/api/config", { webSearch: { provider: "flux" } });
      const noFlux = await search();
      expect(noFlux.status).toBe(409);
      expect(await noFlux.json()).toMatchObject({ code: "missing-config" });
      await desktopApi("PATCH", "/api/config", { webSearch: { provider: "engine" } });
      const engineBackup = await search();
      expect(engineBackup.status).toBe(200);
      expect(await engineBackup.json()).toMatchObject({ routing: "engine-fallback", provider: "parallel", untrusted: true });
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      expect((await search()).status).toBe(401);
      expect(JSON.parse(readFileSync(requestFile, "utf8")).calls).toBe(1);
    } finally {
      await api("POST", `/api/bots/${bot.id}/interrupt`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      await desktopApi("PATCH", "/api/config", { webSearch: { provider: "engine", tavilyApiKey: "" } });
      rmSync(requestFile, { force: true });
    }
  });

  it("keeps native search keys write-only while preserving explicit provider choice", async () => {
    const secret = "search-api-private-fixture-canary";
    const events = await openSse(`${BASE}/api/events`);
    let activeBotId: string | undefined;
    try {
      expect((await api("PATCH", "/api/config", { webSearch: { provider: "tavily", tavilyApiKey: secret } })).status).toBe(404);
      const external = await desktopApi("PATCH", "/api/config?secretStorage=external", { webSearch: { provider: "tavily", tavilyApiKey: secret } });
      expect(external.status).toBe(200);
      expect(JSON.stringify(external.body)).not.toContain(secret);
      expect(JSON.parse(readFileSync(join(home, ".murage", "config.json"), "utf8")).webSearch).toEqual({ provider: "tavily", tavilyApiKey: "" });
      expect((await api("GET", "/api/config")).body.webSearch.tavilyConfigured).toBe(true);
      const firecrawl = await desktopApi("PATCH", "/api/config?secretStorage=external", { webSearch: { firecrawlApiKey: secret + "-firecrawl" } });
      expect(firecrawl.status).toBe(200);
      expect(firecrawl.body.webSearch).toMatchObject({ provider: "tavily", firecrawlConfigured: true });
      expect(JSON.stringify(firecrawl.body)).not.toContain(secret);
      expect(JSON.parse(readFileSync(join(home, ".murage", "config.json"), "utf8")).webSearch.firecrawlApiKey).toBe("");
      const saved = await desktopApi("PATCH", "/api/config", { webSearch: { provider: "tavily", tavilyApiKey: secret, exaApiKey: secret + "-exa" } });
      expect(saved.status).toBe(200);
      expect(JSON.stringify(saved.body)).not.toContain(secret);
      activeBotId = (await desktopApi("POST", "/api/bots")).body.bot.id;
      const activeTurn = await startInternalFixtureTurn(activeBotId!);
      const switched = await desktopApi("PATCH", "/api/config", { webSearch: { provider: "exa" } });
      expect(switched.status).toBe(200);
      expect((await fetch(`${BASE}/api/internal/agents?self=${activeBotId}`, { headers: activeTurn.headers })).status).toBe(200);
      const frame = await events.until(frame => frame.kind === "config" && frame.webSearch?.provider === "exa");
      expect(frame.webSearch).toEqual({ provider: "exa", tavilyConfigured: true, exaConfigured: true, firecrawlConfigured: true, fluxConfigured: false });
      expect(JSON.stringify(frame)).not.toContain(secret);
      // FOLLOW5: the pushed frame replaces the renderer's config wholesale,
      // so the harness announcement must ride on it too, not only on the GET.
      expect(frame.harness).toEqual({ platform: process.platform });
      for (const get of [api, desktopApi]) {
        const visible = await get("GET", "/api/config");
        expect(visible.body.webSearch).toEqual({ provider: "exa", tavilyConfigured: true, exaConfigured: true, firecrawlConfigured: true, fluxConfigured: false });
        expect(JSON.stringify(visible.body)).not.toContain(secret);
      }
      const persisted = JSON.parse(readFileSync(join(home, ".murage", "config.json"), "utf8"));
      expect(persisted.webSearch).toEqual({ provider: "exa", tavilyApiKey: secret, exaApiKey: secret + "-exa", firecrawlApiKey: "" });
      expect((await desktopApi("PATCH", "/api/config", { webSearch: { provider: "automatic-paid-fallback" } })).status).toBe(400);
      const cleared = await desktopApi("PATCH", "/api/config", { webSearch: { provider: "off", tavilyApiKey: "", exaApiKey: "", firecrawlApiKey: "" } });
      expect(cleared.status).toBe(200);
      expect((await api("GET", "/api/config")).body.webSearch).toEqual({ provider: "off", tavilyConfigured: false, exaConfigured: false, firecrawlConfigured: false, fluxConfigured: false });
    } finally {
      events.close();
      if (activeBotId) {
        await api("POST", `/api/bots/${activeBotId}/interrupt`);
        await desktopApi("DELETE", `/api/bots/${activeBotId}`);
      }
      await desktopApi("PATCH", "/api/config", { webSearch: { provider: "engine", tavilyApiKey: "", exaApiKey: "", firecrawlApiKey: "" } });
    }
  });

  it("describes the configured fleet, shadows included", async () => {
    const { status, body } = await api("GET", "/api/instances");
    expect(status).toBe(200);
    const ghost = body.instances.find((instance: { instanceId: string }) => instance.instanceId === "ghost");
    expect(ghost).toMatchObject({
      instanceId: "ghost",
      driverKind: "not-a-real-driver",
      displayName: "Ghost",
      snapshot: { state: "unavailable" },
    });
    expect(ghost.snapshot.reason).toContain("not-a-real-driver");
    expect(body.instances).toContainEqual(expect.objectContaining({
      instanceId: "claude",
      driverKind: "claudeAgent",
      displayName: "Fixture Claude",
    }));
    expect(body.instances.map((instance: { instanceId: string }) => instance.instanceId).sort())
      .toEqual([...Object.keys(FIXTURE_ENGINE_OVERRIDES), "ghost", "claude"].sort());
  });

  it("selects the available fake engine by default while ignoring fixture shadows", async () => {
    const created = await desktopApi("POST", "/api/bots");
    expect(created.status).toBe(201);
    try {
      expect(created.body.bot.modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5" });
    } finally {
      expect((await desktopApi("DELETE", `/api/bots/${created.body.bot.id}`)).status).toBe(200);
    }
  });

  it("searches transcripts and exports a conversation", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    // Every new bot opens with a rotating greeting, so the searchable string
    // is the bot's own name: every opener contains it exactly once. Pinning
    // the sentence instead is how this assertion went stale before.
    const needle: string = bot.name.toLowerCase();
    const hits = await api("GET", `/api/search?q=${encodeURIComponent(needle)}`);
    expect(hits.status).toBe(200);
    const hit = hits.body.hits.find((h: { botId?: string }) => h.botId === bot.id);
    expect(hit).toMatchObject({
      botId: bot.id,
      threadId: bot.threadId,
      name: bot.name,
      kind: "text",
      onActivePath: true,
    });
    expect(hit.snippet.toLowerCase()).toContain(needle);
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe(needle);
    expect((await api("GET", "/api/search?q=")).body.hits).toEqual([]);
    const scoped = await api("GET", `/api/search?q=${encodeURIComponent(needle)}&threadId=${bot.threadId}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.hits.every((candidate: { threadId: string }) => candidate.threadId === bot.threadId)).toBe(true);
    expect((await api("GET", "/api/search?q=hello&threadId=missing-thread")).status).toBe(404);

    const markdown = await fetch(`${BASE}/api/threads/${bot.threadId}/export`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(markdown.headers.get("content-disposition")).toContain("attachment");
    const text = await markdown.text();

    const asJson = await api("GET", `/api/threads/${bot.threadId}/export?format=json`);
    expect(asJson.status).toBe(200);
    expect(asJson.body.messages.length).toBeGreaterThan(0);
    // the export carries the transcript verbatim: check the greeting the
    // store actually seeded, whichever of the openers it drew
    const greeting: string = asJson.body.messages.find((m: { kind: string }) => m.kind === "text").text;
    expect(greeting).toContain(bot.name);
    expect(text).toContain(greeting);
    expect(JSON.stringify(asJson.body)).not.toContain('"png"');
    expect((await api("GET", `/api/threads/${bot.threadId}/export?format=pdf`)).status).toBe(400);
    expect((await api("GET", "/api/threads/nope/export")).status).toBe(404);

    // one pinned message per thread: pin, round-trip, replace, clear; the
    // id is stored verbatim — resolution is the UI's job
    const pin = await desktopApi("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "msg-abc_123" });
    expect(pin.status).toBe(200);
    expect(pin.body.bot).toMatchObject({ pinnedMessageId: "msg-abc_123" });
    const repin = await desktopApi("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "msg-second" });
    expect(repin.body.bot).toMatchObject({ pinnedMessageId: "msg-second" });
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: "not an id!" })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: 42 })).status).toBe(400);
    const unpinned = await desktopApi("PATCH", `/api/bots/${bot.id}`, { pinnedMessageId: null });
    expect(unpinned.status).toBe(200);
    expect(unpinned.body.bot).not.toHaveProperty("pinnedMessageId");

    const room = (await api("POST", "/api/groups", { name: "Pins", memberIds: [bot.id] })).body.group;
    const roomPin = await desktopApi("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "msg-room_1" });
    expect(roomPin.status).toBe(200);
    expect(roomPin.body.group).toMatchObject({ pinnedMessageId: "msg-room_1" });
    const roomRepin = await desktopApi("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "msg-room_2" });
    expect(roomRepin.body.group).toMatchObject({ pinnedMessageId: "msg-room_2" });
    expect((await desktopApi("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "not an id!" })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: 42 })).status).toBe(400);
    const roomCleared = await desktopApi("PATCH", `/api/groups/${room.id}`, { pinnedMessageId: "" });
    expect(roomCleared.status).toBe(200);
    expect(roomCleared.body.group).not.toHaveProperty("pinnedMessageId");

    // deleted conversations drop out of search rather than 404ing it
    await desktopApi("DELETE", `/api/bots/${bot.id}`);
    const after = await api("GET", "/api/search?q=nice%20to%20meet");
    expect(after.body.hits.find((h: { botId?: string }) => h.botId === bot.id)).toBeUndefined();
  });

  it("stores a room reply as a flat reference and rejects foreign targets", async () => {
    const bot = (await desktopApi("POST", "/api/bots")).body.bot;
    const foreign = (await desktopApi("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", { name: "Reply room", memberIds: [bot.id] })).body.group;
    try {
      await desktopApi("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" });
      await desktopApi("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "First thought" })).status).toBe(202);
      let current = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      const original = current.messages.at(-1);
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, {
        text: "Following up",
        replyToId: original.id,
      })).status).toBe(202);
      current = (await api("GET", "/api/bots?messages=20")).body.groups.find(
        (candidate: { id: string }) => candidate.id === room.id,
      );
      expect(current.messages.at(-1)).toMatchObject({ text: "Following up", replyToId: original.id });
      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, {
        text: "Wrong conversation",
        replyToId: foreign.messages[0].id,
      })).status).toBe(404);
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
      await desktopApi("DELETE", `/api/bots/${foreign.id}`);
    }
  });

  it("creates, patches, and deletes a bot", async () => {
    const created = await desktopApi("POST", "/api/bots");
    expect(created.status).toBe(201);
    const bot = created.body.bot;

    const patched = await desktopApi("PATCH", `/api/bots/${bot.id}`, { name: "Renamed", pinned: true });
    expect(patched.status).toBe(200);
    expect(patched.body.bot).toMatchObject({ name: "Renamed", pinned: true });

    const missing = await desktopApi("PATCH", "/api/bots/does-not-exist", { name: "x" });
    expect(missing.status).toBe(404);

    // persona fields are bounded at the write boundary — they reach system
    // prompts (Chief roster, room rosters), so an unbounded PATCH is a
    // token-burn and prompt-injection surface
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { name: "N".repeat(101) })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { name: "   " })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { title: "T".repeat(201) })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { description: "D".repeat(4001) })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { description: 7 })).status).toBe(400);

    // the per-bot composio gate is a boolean, and it round-trips
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { composio: "yes" })).status).toBe(400);
    const gated = await desktopApi("PATCH", `/api/bots/${bot.id}`, { composio: false });
    expect(gated.status).toBe(200);

    // sidebar sections: assign, round-trip, trim, clear — and the field
    // drops off the record entirely once cleared rather than lingering
    // as an empty string through exports and wire frames
    const sectioned = await desktopApi("PATCH", `/api/bots/${bot.id}`, { section: "  Research  " });
    expect(sectioned.status).toBe(200);
    expect(sectioned.body.bot).toMatchObject({ section: "Research" });
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { section: 7 })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { section: "S".repeat(61) })).status).toBe(400);
    const cleared = await desktopApi("PATCH", `/api/bots/${bot.id}`, { section: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot).not.toHaveProperty("section");
    const clearedEmpty = await desktopApi("PATCH", `/api/bots/${bot.id}`, { section: "   " });
    expect(clearedEmpty.status).toBe(200);
    expect(clearedEmpty.body.bot).not.toHaveProperty("section");

    // Channels can be born inside a Work/Personal/project context, and can
    // later move through the same context contract as bots.
    const createdInContext = await api("POST", "/api/groups", {
      name: "Filed",
      memberIds: [bot.id, bot.id],
      section: "  Work  ",
    });
    expect(createdInContext.status).toBe(201);
    expect(createdInContext.body.group).toMatchObject({ section: "Work", memberIds: [bot.id] });
    expect((await api("POST", "/api/groups", { name: 7, memberIds: [bot.id] })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "N".repeat(101), memberIds: [bot.id] })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "Bad context", memberIds: [bot.id], section: 7 })).status).toBe(400);
    expect((await api("POST", "/api/groups", { name: "Long context", memberIds: [bot.id], section: "S".repeat(61) })).status).toBe(400);
    const sectionRoom = createdInContext.body.group;
    const roomSectioned = await desktopApi("PATCH", `/api/groups/${sectionRoom.id}`, { section: "  Clients  " });
    expect(roomSectioned.status).toBe(200);
    expect(roomSectioned.body.group).toMatchObject({ section: "Clients" });
    expect((await desktopApi("PATCH", `/api/groups/${sectionRoom.id}`, { section: 7 })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/groups/${sectionRoom.id}`, { section: "S".repeat(61) })).status).toBe(400);
    const roomSectionCleared = await desktopApi("PATCH", `/api/groups/${sectionRoom.id}`, { section: null });
    expect(roomSectionCleared.status).toBe(200);
    expect(roomSectionCleared.body.group).not.toHaveProperty("section");
    const roomSectionEmpty = await desktopApi("PATCH", `/api/groups/${sectionRoom.id}`, { section: "   " });
    expect(roomSectionEmpty.status).toBe(200);
    expect(roomSectionEmpty.body.group).not.toHaveProperty("section");
    expect((await desktopApi("DELETE", `/api/groups/${sectionRoom.id}`)).status).toBe(200);
    expect(gated.body.bot.composio).toBe(false);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { composio: true })).body.bot.composio).toBe(true);

    const deleted = await desktopApi("DELETE", `/api/bots/${bot.id}`);
    expect(deleted.status).toBe(200);
    const after = await api("GET", "/api/bots");
    expect(after.body.bots.find((b: { id: string }) => b.id === bot.id)).toBeUndefined();
  });

  it("elects one Chief of Staff per section and preserves other section Chiefs", async () => {
    const workA = (await desktopApi("POST", "/api/bots")).body.bot;
    const workB = (await desktopApi("POST", "/api/bots")).body.bot;
    const personal = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      await desktopApi("PATCH", `/api/bots/${workA.id}`, { section: "Work", chiefOfStaff: true });
      await desktopApi("PATCH", `/api/bots/${workB.id}`, { section: "Work" });
      await desktopApi("PATCH", `/api/bots/${personal.id}`, { section: "Personal", chiefOfStaff: true });

      let bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workA.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(true);

      await desktopApi("PATCH", `/api/bots/${workB.id}`, { chiefOfStaff: true });
      bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workA.id).chiefOfStaff).toBe(false);
      expect(bots.find((bot: { id: string }) => bot.id === workB.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(true);

      // Moving a Chief keeps its role and hands off only in the destination.
      await desktopApi("PATCH", `/api/bots/${workB.id}`, { section: "Personal" });
      bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === workB.id).chiefOfStaff).toBe(true);
      expect(bots.find((bot: { id: string }) => bot.id === personal.id).chiefOfStaff).toBe(false);
    } finally {
      for (const bot of [workA, workB, personal]) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  // The Chief's second branch, over the wire the UI actually uses. The role
  // control always sends all three fields at once, so the refusal and the
  // handover both have to behave inside ONE request.
  it("files a bot as an Individual Assistant and refuses the role to a Chief", async () => {
    const chief = (await desktopApi("POST", "/api/bots")).body.bot;
    const bruce = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      await desktopApi("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "workspace" });
      const filed = await desktopApi("PATCH", `/api/bots/${bruce.id}`, {
        section: "Smart Trader",
        chiefOfStaff: false,
        chiefScope: null,
        individual: true,
      });
      expect(filed.status).toBe(200);
      expect(filed.body.bot).toMatchObject({ section: "Smart Trader", individual: true });

      // survives a re-read, and is not merely an echo of the request
      const bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === bruce.id).individual).toBe(true);

      // the two roles are opposite ends of one chart, in one request
      const refused = await desktopApi("PATCH", `/api/bots/${bruce.id}`, { chiefOfStaff: true, individual: true });
      expect(refused.status).toBe(400);
      expect(String(refused.body.error)).toContain("Individual Assistant");
      expect((await api("GET", "/api/bots")).body.bots.find((bot: { id: string }) => bot.id === bruce.id))
        .toMatchObject({ individual: true, chiefOfStaff: false });

      // and refused the other way round too, against the stored role
      await desktopApi("PATCH", `/api/bots/${bruce.id}`, { chiefOfStaff: true, chiefScope: "section", individual: false });
      const promoted = (await api("GET", "/api/bots")).body.bots
        .find((bot: { id: string }) => bot.id === bruce.id);
      expect(promoted.chiefOfStaff).toBe(true);
      expect(promoted.individual).toBeUndefined(); // leading clears the branch
      expect((await desktopApi("PATCH", `/api/bots/${bruce.id}`, { individual: true })).status).toBe(400);

      expect((await desktopApi("PATCH", `/api/bots/${bruce.id}`, { individual: "yes" })).status).toBe(400);
    } finally {
      for (const bot of [chief, bruce]) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("files a sidebar section atomically, trims and dedupes, and preserves its Chief", async () => {
    const incumbent = (await desktopApi("POST", "/api/bots")).body.bot;
    const incoming = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    const teammate = (await desktopApi("POST", "/api/bots", { modelSelection: STATE_ONLY_SELECTION })).body.bot;
    try {
      expect((await desktopApi("PATCH", `/api/bots/${incumbent.id}`, { section: "Launch", chiefOfStaff: true })).status).toBe(200);
      await desktopApi("PATCH", `/api/bots/${incoming.id}`, { section: "Research" });
      await desktopApi("PATCH", `/api/bots/${teammate.id}`, { section: "Personal" });

      const stream = await openSse(`${BASE}/api/events`);
      try {
        await stream.until((frame) => frame.kind === "hello");
        const created = await desktopApi("POST", "/api/sidebar-sections", {
          name: "  Launch  ",
          botIds: [incoming.id, teammate.id, incoming.id],
        });
        expect(created.status).toBe(200);
        expect(created.body.section).toBe("Launch");
        expect(created.body.bots.map((bot: { id: string }) => bot.id)).toEqual([
          incoming.id,
          teammate.id,
        ]);
        expect(created.body.bots.find((bot: { id: string }) => bot.id === incoming.id))
          .toMatchObject({ section: "Launch" });
        expect(Boolean(created.body.bots.find((bot: { id: string }) => bot.id === incoming.id)?.chiefOfStaff))
          .toBe(false);

        for (const id of [incoming.id, teammate.id]) {
          const frame = await stream.until(
            (candidate) => candidate.kind === "bot" && candidate.bot?.id === id,
          );
          expect(frame.bot.section).toBe("Launch");
        }

        const bots = (await api("GET", "/api/bots")).body.bots;
        expect(bots.find((bot: { id: string }) => bot.id === incumbent.id))
          .toMatchObject({ section: "Launch", chiefOfStaff: true });
      } finally {
        stream.close();
      }
    } finally {
      for (const bot of [incumbent, incoming, teammate]) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("rejects a sidebar section Chief collision without changing any bot", async () => {
    const incumbent = (await desktopApi("POST", "/api/bots")).body.bot;
    const incoming = (await desktopApi("POST", "/api/bots")).body.bot;
    const teammate = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      await desktopApi("PATCH", `/api/bots/${incumbent.id}`, { section: "Launch", chiefOfStaff: true });
      await desktopApi("PATCH", `/api/bots/${incoming.id}`, { section: "Research", chiefOfStaff: true });
      await desktopApi("PATCH", `/api/bots/${teammate.id}`, { section: "Personal" });

      const response = await desktopApi("POST", "/api/sidebar-sections", {
        name: "Launch",
        botIds: [incoming.id, teammate.id],
      });
      // The status and the refusal are the contract; the sentence is not.
      // This pinned the whole string and went red at the role rename, where
      // `chiefOfStaff: true` became "team lead" and the message followed it
      // (`server/index.ts:7443`). The product was right and the test was
      // stale — the third time a literal has done that in this suite. Assert
      // the constraint the message must state, and let the wording move.
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/only one lead/);

      const bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === incumbent.id))
        .toMatchObject({ section: "Launch", chiefOfStaff: true });
      expect(bots.find((bot: { id: string }) => bot.id === incoming.id))
        .toMatchObject({ section: "Research", chiefOfStaff: true });
      expect(bots.find((bot: { id: string }) => bot.id === teammate.id))
        .toMatchObject({ section: "Personal" });
      expect(Boolean(bots.find((bot: { id: string }) => bot.id === teammate.id)?.chiefOfStaff))
        .toBe(false);
    } finally {
      for (const bot of [incumbent, incoming, teammate]) await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

  it("rejects malformed or unavailable sidebar section targets without partially filing bots", async () => {
    const visible = (await desktopApi("POST", "/api/bots")).body.bot;
    const hidden = (await desktopApi("POST", "/api/bots")).body.bot;
    try {
      await desktopApi("PATCH", `/api/bots/${visible.id}`, { section: "Original" });
      await desktopApi("PATCH", `/api/bots/${hidden.id}`, { hidden: true, chiefOfStaff: false });

      for (const body of [
        { name: "   ", botIds: [visible.id] },
        { name: "S".repeat(61), botIds: [visible.id] },
        { name: "Work", botIds: [] },
        { name: "Work", botIds: ["not/an/id"] },
        { name: "Work", botIds: [visible.id], extra: true },
      ]) {
        expect((await desktopApi("POST", "/api/sidebar-sections", body)).status).toBe(400);
      }
      expect((await desktopApi("POST", "/api/sidebar-sections", {
        name: "Work",
        botIds: [visible.id, "missing"],
      })).status).toBe(404);
      expect((await desktopApi("POST", "/api/sidebar-sections", {
        name: "Work",
        botIds: [visible.id, hidden.id],
      })).status).toBe(404);

      const bots = (await api("GET", "/api/bots")).body.bots;
      expect(bots.find((bot: { id: string }) => bot.id === visible.id)?.section).toBe("Original");
    } finally {
      await desktopApi("DELETE", `/api/bots/${visible.id}`);
      await desktopApi("DELETE", `/api/bots/${hidden.id}`);
    }
  });

  it("explains when archived room members cannot respond", async () => {
    const archived = (await desktopApi("POST", "/api/bots")).body.bot;
    const active = (await desktopApi("POST", "/api/bots")).body.bot;
    const room = (await api("POST", "/api/groups", {
      name: "Archived member feedback",
      memberIds: [archived.id, active.id],
    })).body.group;

    try {
      expect((await desktopApi("PATCH", `/api/groups/${room.id}/setup`, { action: "skip" })).status).toBe(200);
      const archivedBot = await desktopApi("PATCH", `/api/bots/${archived.id}`, {
        name: "Quill",
        hidden: true,
        chiefOfStaff: false,
      });
      expect(archivedBot.status).toBe(200);
      await desktopApi("PATCH", `/api/bots/${active.id}`, {
        name: "Atlas",
        modelSelection: { instanceId: "ghost", model: "ghost-1" },
      });
      await desktopApi("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });

      expect((await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "@Quill take this" })).status).toBe(202);
      let state = (await api("GET", "/api/bots?messages=20")).body;
      let messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)).toMatchObject({
        kind: "activity",
        tool: {
          name: "Quill is archived and can't respond: restore it or mention an active room member.",
          ok: false,
        },
      });

      const archivedError = "Quill is archived and can't respond: restore it or mention an active room member.";
      const beforeMixedMention = messages.filter((message: { tool?: { name?: string } }) =>
        message.tool?.name === archivedError
      ).length;
      await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "@Quill and @Atlas take this" });
      await expect.poll(async () => {
        state = (await api("GET", "/api/bots?messages=20")).body;
        messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
        return {
          archivedErrors: messages.filter((message: { tool?: { name?: string } }) =>
            message.tool?.name === archivedError
          ).length,
          activeDispatched: messages.some((message: { tool?: { name?: string } }) =>
            message.tool?.name === "error: Atlas's model is unavailable"
          ),
        };
      }).toEqual({ archivedErrors: beforeMixedMention + 1, activeDispatched: true });

      await desktopApi("PATCH", `/api/groups/${room.id}`, {
        defaultResponder: { kind: "member", botId: archived.id },
      });
      await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "use the default responder" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)?.tool).toEqual({ name: archivedError, ok: false });

      await desktopApi("PATCH", `/api/groups/${room.id}`, { defaultResponder: { kind: "mentions" } });

      const beforeUnmentioned = messages.length;
      await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "no mention" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages).toHaveLength(beforeUnmentioned + 1);
      expect(messages.at(-1)).toMatchObject({ kind: "text", role: "user", text: "no mention" });

      await desktopApi("PATCH", `/api/bots/${active.id}`, { hidden: true });
      await desktopApi("POST", `/api/groups/${room.id}/messages`, { text: "hello everyone" });
      state = (await api("GET", "/api/bots?messages=20")).body;
      messages = state.groups.find((group: { id: string }) => group.id === room.id).messages;
      expect(messages.at(-1)).toMatchObject({
        kind: "activity",
        tool: {
          name: "No active room members can respond: restore an archived bot or add an active member.",
          ok: false,
        },
      });
    } finally {
      await desktopApi("DELETE", `/api/groups/${room.id}`);
      await desktopApi("DELETE", `/api/bots/${archived.id}`);
      await desktopApi("DELETE", `/api/bots/${active.id}`);
    }
  });

  it("saves, serves, and guards image attachments", async () => {
    // a real 1x1 PNG so the bytes round-trip intact
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    const wrongType = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not an image",
    });
    expect(wrongType.status).toBe(400);

    const saved = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(png),
    });
    expect(saved.status).toBe(201);
    const { path: savedPath, mime, bytes } = (await saved.json()) as { path: string; mime: string; bytes: number };
    expect(mime).toBe("image/png");
    expect(bytes).toBe(png.byteLength);
    expect(savedPath).toContain("attachments");

    const name = savedPath.split(/[\\/]/).pop();
    const served = await fetch(`${BASE}/api/attachments/${name}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);

    // the serving route is name-locked to the attachments dir
    const traversal = await fetch(`${BASE}/api/attachments/..%2F..%2Fconfig.json`);
    expect(traversal.status).toBe(404);
    const unknown = await fetch(`${BASE}/api/attachments/00000000-0000-0000-0000-000000000000.png`);
    expect(unknown.status).toBe(404);

    const tooBig = await fetch(`${BASE}/api/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: Buffer.alloc(IMAGE_MAX_BYTES + 1),
    });
    expect(tooBig.status).toBe(413);

    const uploadId = "11111111-1111-4111-8111-111111111111";
    const idempotent = await fetch(`${BASE}/api/attachments?uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(png),
    });
    expect(idempotent.status).toBe(201);
    const idempotentResult = (await idempotent.json()) as { path: string };
    const retry = await fetch(`${BASE}/api/attachments?uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(png),
    });
    expect(retry.status).toBe(201);
    expect((await retry.json() as { path: string }).path).toBe(idempotentResult.path);

    const conflictingRetry = await fetch(`${BASE}/api/attachments?uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(conflictingRetry.status).toBe(409);

    const malformedId = await fetch(`${BASE}/api/attachments?uploadId=..%2Fescape`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(png),
    });
    expect(malformedId.status).toBe(400);
  });

  it("streams shared documents safely into the local attachments directory", async () => {
    const contents = Buffer.from("name,score\nAda,10\n");
    const saved = await fetch(`${BASE}/api/files?name=${encodeURIComponent("scores.exe")}`, {
      method: "POST",
      headers: { "content-type": "text/csv; charset=utf-8" },
      body: contents,
    });
    expect(saved.status).toBe(201);
    const result = (await saved.json()) as { path: string; name: string; mime: string; bytes: number };
    expect(result).toMatchObject({ name: "scores.csv", mime: "text/csv", bytes: contents.byteLength });
    expect(result.path).toMatch(/[\\/]attachments[\\/][0-9a-f-]+\.csv$/);
    expect(readFileSync(result.path).equals(contents)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(dirname(result.path)).mode & 0o777).toBe(0o700);
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    }

    const unsupported = await fetch(`${BASE}/api/files?name=payload.zip`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: Buffer.from("archive"),
    });
    expect(unsupported.status).toBe(400);

    const missingName = await fetch(`${BASE}/api/files`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("hello"),
    });
    expect(missingName.status).toBe(400);

    for (const name of ["..%2F..%2Fsecret.txt", "..%5C..%5Csecret.txt", "..%252F..%252Fsecret.txt"]) {
      const traversal = await fetch(`${BASE}/api/files?name=${name}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: Buffer.from("hello"),
      });
      expect(traversal.status, name).toBe(400);
    }

    const empty = await fetch(`${BASE}/api/files?name=empty.pdf`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: Buffer.alloc(0),
    });
    expect(empty.status).toBe(400);

    const tooBig = await fetch(`${BASE}/api/files?name=large.pdf`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: Buffer.alloc(FILE_MAX_BYTES + 1),
    });
    expect(tooBig.status).toBe(413);

    const uploadId = "22222222-2222-4222-8222-222222222222";
    const first = await fetch(`${BASE}/api/files?name=notes.txt&uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("retry-safe"),
    });
    expect(first.status).toBe(201);
    const firstResult = (await first.json()) as { path: string };
    const retry = await fetch(`${BASE}/api/files?name=notes.txt&uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("retry-safe"),
    });
    expect(retry.status).toBe(201);
    expect((await retry.json() as { path: string }).path).toBe(firstResult.path);

    const conflictingRetry = await fetch(`${BASE}/api/files?name=notes.txt&uploadId=${uploadId}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("different"),
    });
    expect(conflictingRetry.status).toBe(409);

    const malformedId = await fetch(`${BASE}/api/files?name=notes.txt&uploadId=not-a-uuid`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: Buffer.from("hello"),
    });
    expect(malformedId.status).toBe(400);
  });

  it("persists only app-owned bot avatars and supported crop shapes", async () => {
    const created = await desktopApi("POST", "/api/bots");
    const bot = created.body.bot;
    const avatarUrl = await uploadAvatar("image/webp");

    const saved = await desktopApi("PATCH", `/api/bots/${bot.id}`, { avatarUrl, avatarCrop: "rounded" });
    expect(saved.status).toBe(200);
    expect(saved.body.bot).toMatchObject({ avatarUrl, avatarCrop: "rounded" });

    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
      avatarUrl: "https://tracker.example/avatar.png",
    })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, {
      avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
    })).status).toBe(400);
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { avatarCrop: "hexagon" })).status).toBe(400);

    const cleared = await desktopApi("PATCH", `/api/bots/${bot.id}`, { avatarUrl: null, avatarCrop: "mascot" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.bot.avatarUrl).toBeNull();
    expect(cleared.body.bot.avatarCrop).toBe("mascot");
  });

  it("limits paired profile writes to validated profile fields and broadcasts the result", async () => {
    const created = await desktopApi("POST", "/api/bots");
    const bot = created.body.bot;
    const avatarUrl = await uploadAvatar();
    const stream = await openSse(`${BASE}/api/events`);
    try {
      await stream.until((frame) => frame.kind === "hello");
      const saved = await phoneApi("PATCH", `/api/bots/${bot.id}/profile`, {
        name: "Paired Profile",
        title: "Mobile-safe agent",
        description: "Only profile data crosses this boundary.",
        notifications: false,
        avatarUrl,
        avatarCrop: "circle",
        voice: "voice_fixture",
        speakReplies: true,
      });
      expect(saved.status).toBe(200);
      expect(saved.body.bot).toMatchObject({
        name: "Paired Profile",
        title: "Mobile-safe agent",
        description: "Only profile data crosses this boundary.",
        notifications: false,
        avatarUrl,
        avatarCrop: "circle",
        voice: "voice_fixture",
        speakReplies: true,
      });
      const frame = await stream.until(
        (candidate) => candidate.kind === "bot" && candidate.bot?.id === bot.id,
      );
      expect(frame.bot).toMatchObject({ id: bot.id, avatarUrl, avatarCrop: "circle" });

      for (const invalid of [
        { color: "red" },
        { avatarUrl: "https://tracker.example/avatar.png" },
        { avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png" },
        { avatarCrop: "hexagon" },
        { name: 42 },
        { notifications: "yes" },
        { voice: null },
        { speakReplies: 1 },
      ]) {
        expect((await phoneApi("PATCH", `/api/bots/${bot.id}/profile`, invalid)).status).toBe(400);
      }

      const cleared = await phoneApi("PATCH", `/api/bots/${bot.id}/profile`, {
        avatarUrl: null,
        avatarCrop: "mascot",
        voice: "",
        speakReplies: false,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.bot).toMatchObject({
        avatarUrl: null,
        avatarCrop: "mascot",
        voice: "",
        speakReplies: false,
      });
    } finally {
      stream.close();
      await desktopApi("DELETE", `/api/bots/${bot.id}`);
    }
  });

});

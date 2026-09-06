// The /api/events firehose, pinned at the wire.
//
// `sse-visibility.test.ts` covers the decision; this covers the wiring, and
// the wiring is the part that was wrong. Every SSE client used to receive
// every frame `broadcast()` wrote, so a paired device holding this stream
// open read every message on every thread in real time — which is a wider
// read than the route allowlist grants it anywhere else.
//
// Two streams on one harness: the renderer's, which opts out of scoping with
// `?surface=desktop` plus this launch's desktop secret, and a paired
// device's, which arrives through the sidecar with `x-murage-companion: 1`.
// A hidden bot's transcript must reach the first and not the second.
//
// Scoping is the DEFAULT, so the renderer is the side that has to say
// something. That is the polarity on purpose: an unmarked stream — a door
// added later that never heard of this file — gets the narrow feed, not the
// firehose.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess;
let home: string;
let stderr = "";
let BASE = "";

/** Marker plus proof. `?${DESKTOP_QUERY}` alone is a remote request now. */
const DESKTOP_SECRET = "fedcba9876543210".repeat(4);
const DESKTOP_QUERY = `surface=desktop&surfaceSecret=${DESKTOP_SECRET}`;
const DESKTOP_HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET };

const api = async (
  method: string,
  path: string,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

const desktopApi = (method: string, path: string, body?: unknown) => api(method, path, body, DESKTOP_HEADERS);
const model = { instanceId: "scopeFixture", model: "fake-model" };

posixOnly("the events stream is scoped per client", () => {
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-sse-scope-e2e-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(
      join(home, ".murage", "config.json"),
      JSON.stringify({
        // A product-keyed `grok` entry auto-adds unrelated engines. This test
        // needs exactly the local fake, regardless of installed user CLIs.
        instances: { scopeFixture: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: false } } },
      }),
    );

    const port = await freePortBlock([0, 1]);
    BASE = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      MURAGE_PORT: String(port),
      MURAGE_WEBHOOK_PORT: String(port + 1),
      // The desktop marker is not believed on its own any more — the harness
      // wants this launch's secret with it. Pinning it through the dev
      // injection is how the Vite renderer and the Playwright rig get one
      // too; a packaged child refuses the variable outright.
      MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET,
    };
    if (process.env.PATH) env.PATH = process.env.PATH;

    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 60_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  // Reactions are a WRITE route that reads back: the patched message is
  // returned in full. So a client that can no longer list a hidden thread
  // could still name one, get its content, and leave a reaction on it.
  it("refuses a reaction on a hidden thread, and does not confirm it exists", async () => {
    const created = await api("POST", "/api/bots", { name: "Reactor" });
    expect(created.status, stderr).toBe(201);
    const bot = created.body.bot;
    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { modelSelection: model })).status).toBe(200);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "react to me" })).status).toBe(202);

    const desktop = DESKTOP_HEADERS;
    const phone = { "x-murage-companion": "1" };
    let messageId = "";
    for (let attempt = 0; attempt < 100 && !messageId; attempt++) {
      const page = await api("GET", `/api/threads/${bot.threadId}/messages`, undefined, desktop);
      messageId = page.body?.messages?.[0]?.id ?? "";
      if (!messageId) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(messageId, stderr).toBeTruthy();

    // Visible: the phone may react, which is the control for what follows.
    expect((await api("POST", `/api/threads/${bot.threadId}/messages/${messageId}/reactions`,
      { emoji: "👍" }, phone)).status).toBe(200);

    expect((await desktopApi("PATCH", `/api/bots/${bot.id}`, { hidden: true })).status).toBe(200);

    const refused = await api("POST", `/api/threads/${bot.threadId}/messages/${messageId}/reactions`,
      { emoji: "🔥" }, phone);
    expect(refused.status).toBe(404);
    // Not 403, and no message body echoed back: a 403 would confirm the
    // thread exists, which is the fact being withheld.
    expect(JSON.stringify(refused.body)).not.toContain("react to me");

    // The desktop is unaffected.
    expect((await api("POST", `/api/threads/${bot.threadId}/messages/${messageId}/reactions`,
      { emoji: "🔥" }, desktop)).status).toBe(200);
  });

  it(
    "sends a hidden bot's transcript to the renderer and not to a paired device",
    async () => {
      const listed = await api("GET", "/api/bots");
      const secret = listed.body.bots[0];
      expect(secret, stderr).toBeTruthy();
      expect((await desktopApi("PATCH", `/api/bots/${secret.id}`, { modelSelection: model, hidden: true })).status).toBe(200);

      const created = await api("POST", "/api/bots", { name: "Ordinary" });
      expect(created.status).toBe(201);
      const ordinary = created.body.bot;
      expect((await desktopApi("PATCH", `/api/bots/${ordinary.id}`, { modelSelection: model })).status).toBe(200);

      let desktop: SseRecorder | undefined;
      let phone: SseRecorder | undefined;
      try {
        desktop = await openSse(`${BASE}/api/events?${DESKTOP_QUERY}`);
        phone = await openSse(`${BASE}/api/events`, { "x-murage-companion": "1" });
        await desktop.until((frame) => frame.kind === "hello");
        await phone.until((frame) => frame.kind === "hello");

        // Everything the hidden bot's whole turn broadcasts happens here.
        expect((await api("POST", `/api/bots/${secret.id}/messages`, { text: "the passphrase is hunter2" })).status)
          .toBe(202);
        // The renderer sees it — both what was sent and what came back.
        await desktop.until(
          (frame) => frame.kind === "message" && frame.threadId === secret.threadId && frame.message?.role === "user",
          20_000,
        );
        await desktop.until(
          (frame) => frame.kind === "message" && frame.threadId === secret.threadId && frame.message?.role === "bot",
          20_000,
        );

        // The barrier. Frames leave broadcast() in one order for every
        // client, so once the phone has this one, anything the hidden turn
        // emitted has already been offered to it and refused.
        expect((await api("POST", `/api/bots/${ordinary.id}/messages`, { text: "what is on today" })).status).toBe(202);
        await phone.until(
          (frame) => frame.kind === "message" && frame.threadId === ordinary.threadId && frame.message?.role === "user",
          20_000,
        );

        const leaked = phone.frames.filter((frame) => JSON.stringify(frame).includes(secret.threadId));
        expect(leaked, `paired device received ${leaked.length} frame(s) for the hidden thread`).toEqual([]);
        expect(phone.frames.some((frame) => JSON.stringify(frame).includes("hunter2"))).toBe(false);
        // and the phone is a working stream, not a silent one
        expect(phone.frames.some((frame) => frame.kind === "message" && frame.threadId === ordinary.threadId))
          .toBe(true);
      } finally {
        desktop?.close();
        phone?.close();
      }
    },
    90_000,
  );

  it(
    "does not hand a hidden thread back on resume either",
    async () => {
      // ?surface=desktop: /api/bots is scoped by default now, and a scoped
      // roster is exactly the one that does NOT list a hidden bot.
      const listed = await api("GET", `/api/bots?${DESKTOP_QUERY}`);
      const secret = listed.body.bots.find((bot: any) => bot.hidden);
      expect(secret, "the first test's hidden bot").toBeTruthy();

      // Connect, take a cursor, disconnect — the shape of a phone locking.
      const first = await openSse(`${BASE}/api/events`, { "x-murage-companion": "1" });
      const hello = await first.until((frame) => frame.kind === "hello");
      first.close();

      expect((await api("POST", `/api/bots/${secret.id}/messages`, { text: "and the vault code is 4815" })).status)
        .toBe(202);
      // Wait on an unscoped stream so the hidden turn is known to be in the
      // replay buffer before the scoped client asks for the gap.
      const witness = await openSse(`${BASE}/api/events?${DESKTOP_QUERY}`);
      try {
        await witness.until(
          (frame) => frame.kind === "message" && frame.threadId === secret.threadId && frame.message?.role === "bot",
          20_000,
        );
      } finally {
        witness.close();
      }

      const resumed = await openSse(`${BASE}/api/events`, {
        "x-murage-companion": "1",
        "last-event-id": hello.cursor,
      });
      try {
        const replayed = await resumed.until((frame) => frame.kind === "hello");
        expect(replayed.resumed, "the buffer should still reach back to that cursor").toBe(true);
        // Replay is synchronous with the hello frame that precedes it.
        const leaked = resumed.frames.filter((frame) => JSON.stringify(frame).includes(secret.threadId));
        expect(leaked, `resume replayed ${leaked.length} hidden frame(s)`).toEqual([]);
        expect(resumed.frames.some((frame) => JSON.stringify(frame).includes("4815"))).toBe(false);
      } finally {
        resumed.close();
      }
    },
    90_000,
  );
});

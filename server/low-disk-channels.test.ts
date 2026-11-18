// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance (docs/designs/boot-tolerance/ACCEPTANCE.md, A2 + design correction 2): on a real small filesystem, a start below the start floor with
// Slack, Discord and WhatsApp configured resumes no channel (each is a declared boot step named in the held-back line), creates no channel receipt
// store, leaves messages.db as it was, and keeps serving reads.
// Runs only where /strict is a real mount (it-remote IT_DOCKER_EXTRA="--tmpfs /strict:size=256m"). HEADLESS ONLY: throwaway HOME, probed port.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { MiB, STRICT, desktopHeaders, fillTo, healthOk, onStrictMount, sleep, startServer, type Run } from "./testing/strict-fs.ts";

const FAKE_CLAUDE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude-cli.ts");
// The fixture's Slack and Discord tokens are refused by their constructors ("configuration needs review") before the resume step is reached, so
// only WhatsApp reaches its guard here; the Slack/Discord guards are pinned by W6 (boot-steps-declared) and the store gate by W-LEDGER-RO.
// memory.openTurnsBoot: the open-turns count is a boot step the read-only start skips, so it is named too (Fable Medium 10).
const CHANNEL_STEPS = ["channels.whatsapp.resume", "memory.openTurnsBoot"];

describe.skipIf(!onStrictMount)("a read-only start with channels configured", () => {
  const root = join(STRICT, "chan");
  let run: Run | undefined;
  afterAll(async () => { if (run && run.exited() === undefined) await waitForExit(run.child, { signal: "SIGTERM" }); rmSync(root, { recursive: true, force: true }); });

  it("W-CHAN-RO: no channel resumes, no receipt store is made, messages.db is unchanged, and reads keep working", { timeout: 300_000 }, async () => {
    rmSync(root, { recursive: true, force: true });
    const home = join(root, "home"), data = join(home, ".murage"); mkdirSync(data, { recursive: true });
    chmodSync(FAKE_CLAUDE, 0o755);
    const engine = { claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "happy" }, config: { cli: FAKE_CLAUDE } } };
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: engine }));
    const port = await freePortBlock([0, 1], 19_611, 200);
    // the owner's data, made by a normal start and stopped
    run = startServer(home, port);
    expect(await healthOk(port, run), run.out().slice(-4000)).toBe(true);
    await waitForExit(run.child, { signal: "SIGTERM" });
    expect(existsSync(join(data, "messages.db"))).toBe(true);
    const dbBytes = readFileSync(join(data, "messages.db"));
    const channels = () => existsSync(join(data, "channels")) ? readdirSync(join(data, "channels"), { recursive: true }).map(String).sort() : null;
    const channelsBefore = channels();
    // then the channels are configured, and the disk fills
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: engine,
      slack: { appToken: "fixture-app-token", botToken: "fixture-bot-token", targetBotId: "fixture-bot" },
      discord: { botToken: "fixture-discord-token", targetBotId: "fixture-bot" },
      whatsapp: { targetBotId: "fixture-bot" },
    }));
    fillTo(join(root, "ballast"), 100 * MiB);
    run = startServer(home, port);
    expect(await healthOk(port, run), run.out().slice(-4000)).toBe(true);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { diskLow?: { mode?: string } };
    expect(health.diskLow?.mode).toBe("read-only");
    const deadline = Date.now() + 30_000;
    while (!/held back=/.test(run.out()) && Date.now() < deadline) await sleep(50);
    const held = /\[startup\] read-only start: held back=([^\n]*)/.exec(run.out())?.[1]?.split(",") ?? [];
    expect(held, run.out().slice(-4000)).toEqual(expect.arrayContaining(CHANNEL_STEPS));
    const headers = await desktopHeaders(port);
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/bots?messages=0`, { headers });
      expect(res.status, await res.clone().text()).toBe(200);
    }
    expect(run.exited(), "still serving").toBeUndefined();
    expect(run.out()).not.toMatch(/unhandledRejection|database is not open|database connection is not open/i);
    expect(channels(), "no channel folder or receipt store was made").toEqual(channelsBefore);
    expect((channels() ?? []).some(name => name.endsWith("delivery-ledger.db"))).toBe(false);
    expect(readFileSync(join(data, "messages.db")).equals(dbBytes), "messages.db bytes unchanged").toBe(true);
  });
});

describe.skipIf(!onStrictMount)("a first-ever read-only start", () => {
  const root = join(STRICT, "first");
  let run: Run | undefined;
  afterAll(async () => { if (run && run.exited() === undefined) await waitForExit(run.child, { signal: "SIGTERM" }); rmSync(root, { recursive: true, force: true }); });

  it("W-FIRST-RO: a fresh data dir (config.json only) below the start floor reaches ready, serves reads and makes no database file", { timeout: 300_000 }, async () => {
    rmSync(root, { recursive: true, force: true });
    const home = join(root, "home"), data = join(home, ".murage"); mkdirSync(data, { recursive: true });
    chmodSync(FAKE_CLAUDE, 0o755);
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { claude: { driver: "claudeAgent", environment: { FAKE_CLAUDE_MODE: "happy" }, config: { cli: FAKE_CLAUDE } } } }));
    fillTo(join(root, "ballast"), 100 * MiB);
    const port = await freePortBlock([0, 1], 19_811, 200);
    run = startServer(home, port);
    expect(await healthOk(port, run), run.out().slice(-4000)).toBe(true);
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { diskLow?: { mode?: string } };
    expect(health.diskLow?.mode).toBe("read-only");
    const headers = await desktopHeaders(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/bots?messages=0`, { headers });
    expect(res.status, await res.clone().text()).toBe(200);
    await sleep(2000);
    expect(run.exited(), run.out().slice(-4000)).toBeUndefined();
    expect(run.out()).not.toMatch(/unhandledRejection|Missing chat generation/);
    expect(existsSync(join(data, "messages.db")), "the primary store is only in memory").toBe(false);
  });
});

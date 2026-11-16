import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  controlResultSucceeded,
  launchVerificationServer,
  runControlMurage,
} from "../scripts/control-murage.ts";

describe("control-murage command mapping", () => {
  it("treats unhealthy doctor and non-settled waits as command failures", () => {
    expect(controlResultSucceeded("doctor", { ok: true })).toBe(true);
    expect(controlResultSucceeded("doctor", { ok: false })).toBe(false);
    expect(controlResultSucceeded("wait", { status: "settled" })).toBe(true);
    for (const status of ["failed", "stalled", "timed-out", "needs-user"]) {
      expect(controlResultSucceeded("wait", { status })).toBe(false);
    }
  });

  it("runs directly under Node's strip-only TypeScript loader", () => {
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      join(process.cwd(), "scripts", "control-murage.ts"),
      "help",
    ], { windowsHide: true, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("control-murage");
  });

  it("composes doctor from the shared health and model tools", async () => {
    const callTool = vi.fn(async (name: string) => name === "get_system_health"
      ? { status: "connected", app: "murage" }
      : {
          instances: [
            { instanceId: "ready", snapshot: { state: "available" } },
            { instanceId: "missing", snapshot: { state: "unavailable" } },
          ],
        });
    const result = await runControlMurage(["doctor", "--url", "http://127.0.0.1:19999"], {
      callTool: callTool as any,
    }) as any;
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(["get_system_health", "list_available_models"]);
    expect(result).toMatchObject({
      ok: true,
      health: { endpoint: "http://127.0.0.1:19999" },
      availableEngines: ["ready"],
    });
  });

  it("rejects an available engine when the endpoint is not Murage", async () => {
    const callTool = vi.fn(async (name: string) => name === "get_system_health"
      ? { status: "connected", app: "another-app" }
      : { instances: [{ instanceId: "ready", snapshot: { state: "available" } }] });

    const result = await runControlMurage(["doctor", "--url", "http://127.0.0.1:19999"], {
      callTool: callTool as any,
    }) as any;

    expect(result.ok).toBe(false);
  });

  it("refuses to mutate a silently discovered live app", async () => {
    await expect(runControlMurage(["new-bot", "--name", "Probe"], {
      callTool: vi.fn() as any,
      env: {},
    })).rejects.toMatchObject({
      message: "mutating commands require an explicit Murage instance",
    });
  });

  it("maps bounded reads and dry-run actions without reimplementing them", async () => {
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({ name, args }));
    const env = { MURAGE_URL: "http://127.0.0.1:19999" };
    await expect(runControlMurage(["messages", "--channel", "room-1", "--limit", "20"], {
      callTool: callTool as any,
      env,
    })).resolves.toEqual({ name: "get_channel_messages", args: { channel_id: "room-1", limit: 20 } });

    await expect(runControlMurage(["send", "--bot", "bot-1", "--text", "hello", "--dry-run"], {
      callTool: callTool as any,
      env: {},
    })).resolves.toMatchObject({
      dryRun: true,
      tool: "send_bot_message",
      arguments: { bot_id: "bot-1", text: "hello" },
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid bounds before the shared tool is called", async () => {
    const callTool = vi.fn();
    await expect(runControlMurage(["wait", "--bot", "bot-1", "--timeout", "0"], {
      callTool: callTool as any,
      env: {},
    })).rejects.toThrow("--timeout must be an integer from 1 to 120");
    expect(callTool).not.toHaveBeenCalled();
  });
});

describe("control-murage isolated verification loop", () => {
  it("loads fixture instrumentation through a file URL before server startup", async () => {
    const session = await launchVerificationServer(process.env, undefined, {
      instrumentationSource: `
        import { writeFileSync } from "node:fs";
        writeFileSync(new URL("./instrumentation-loaded.txt", import.meta.url), "loaded");
      `,
    });
    try {
      const importIndex = session.child.spawnargs.indexOf("--import");
      expect(importIndex).toBeGreaterThan(0);
      const specifier = session.child.spawnargs[importIndex + 1];
      expect(new URL(specifier).protocol).toBe("file:");
      expect(fileURLToPath(specifier)).toBe(join(session.info.dataDir, ".verification-instrumentation.mjs"));
      expect(readFileSync(join(session.info.dataDir, "instrumentation-loaded.txt"), "utf8")).toBe("loaded");
    } finally {
      await session.close();
    }
    expect(existsSync(session.info.dataDir)).toBe(false);
  }, 30_000);

  it("launches, drives a real fake-engine turn, and removes only its test data", async () => {
    const session = await launchVerificationServer({
      ...process.env,
      COMPOSIO_API_KEY: "must-not-reach-the-fixture",
      MURAGE_SKILLS_DIR: "/must/not/reach/the/fixture",
      XAI_API_KEY: "must-not-reach-the-fixture",
    });
    const env = { MURAGE_URL: session.info.url };
    try {
      const doctor = await runControlMurage(["doctor"], { env }) as any;
      expect(doctor.ok).toBe(true);
      // Fixture discovery is exact: an ambient real CLI must never enter the
      // model picker or become the default recipient of a verification turn.
      expect(doctor.availableEngines).toEqual(["verification"]);
      expect(doctor.instances.map((instance: { instanceId: string }) => instance.instanceId)).toEqual(["verification"]);

      const created = await runControlMurage(["new-bot", "--name", "Verification Probe"], { env }) as any;
      const botId = created.bot.id as string;
      await runControlMurage(["send", "--bot", botId, "--text", "hello from the verification test"], { env });
      const settled = await runControlMurage(["wait", "--bot", botId, "--timeout", "20"], { env }) as any;
      expect(settled.status).toBe("settled");
      const transcript = await runControlMurage(["messages", "--bot", botId, "--limit", "10"], { env }) as any;
      expect(transcript.messages.some((message: { role?: string }) => message.role === "bot")).toBe(true);
      const fixtureEnv = JSON.parse(readFileSync(session.fixtureDumpPath, "utf8")).env as Record<string, string>;
      expect(fixtureEnv).not.toHaveProperty("COMPOSIO_API_KEY");
      expect(fixtureEnv).not.toHaveProperty("MURAGE_SKILLS_DIR");
      expect(fixtureEnv).not.toHaveProperty("XAI_API_KEY");
      expect(JSON.stringify(fixtureEnv)).not.toContain("must-not-reach-the-fixture");
    } finally {
      await session.close();
    }
    expect(existsSync(session.info.dataDir)).toBe(false);
    expect(existsSync(session.info.logPath)).toBe(true);
  }, 30_000);
});

/** The status route is owner-only; use the isolated server's actual desktop credential. */
async function fixtureMemoryMode(url: string): Promise<string> {
  const proofResponse = await fetch(url + '/api/desktop-secret');
  expect(proofResponse.status).toBe(200);
  const proof = await proofResponse.json() as { secret: string };
  const response = await fetch(url + '/api/memory/status', { headers: {
    'x-murage-surface': 'desktop', 'x-murage-surface-secret': proof.secret,
  } });
  expect(response.status).toBe(200);
  return (await response.json() as { mode: string }).mode;
}

it('the isolated launcher starts checked memory capture with the native meter', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const session = await launchVerificationServer(process.env, undefined, {
    // Native admission producer: scperf-p1; capture consumer: c4-misc-c3.
    // Capture mode isolates the checked writer from active-recall readiness;
    // the separate cold-view regression below retains active mode.
    instrumentationSource: `globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
      const {setMemoryMode}=await import(${JSON.stringify(new URL('./memory/repository.ts', import.meta.url).href)});
      setMemoryMode('capture');`,
  });
  const env = { MURAGE_URL: session.info.url };
  try {
    expect(await fixtureMemoryMode(session.info.url)).toBe('capture');
    const { bot } = await runControlMurage(['new-bot', '--name', 'Capture fixture'], { env }) as any;
    await runControlMurage(['send', '--bot', bot.id, '--text', 'Remember the fixture gate is blue.'], { env });
    expect((await runControlMurage(['wait', '--bot', bot.id, '--timeout', '20'], { env }) as any).status).toBe('settled');
    expect(typeof bot.activeTaskId).toBe('string');
    await expect.poll(() => {
      const db = new DatabaseSync(join(session.info.dataDir, 'messages.db'), { readOnly: true });
      try { return Number(db.prepare("SELECT count(*) AS n FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=? AND j.status='complete'").get(bot.activeTaskId)?.n ?? 0); }
      finally { db.close(); }
    }, { timeout: 20000 }).toBeGreaterThan(0);
    expect(readFileSync(session.info.logPath, 'utf8')).not.toContain('BG_ENFORCEMENT_UNAVAILABLE');
  } finally { await session.close(); }
});


it('the first direct turn waits for a genuinely constructed recall view before engine dispatch', async () => {
  const session = await launchVerificationServer(process.env, undefined, {
    turnLog: { replies: ['Fixture cold-view reply.'] },
    instrumentationSource: `
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
      const {registerHooks}=await import('node:module'),path=await import('node:path');
      const marker=path.join(process.env.MURAGE_DATA_DIR,'cold-view-requested');
      registerHooks({load(url,context,next){
        const result=next(url,context);
        if(!url.endsWith('/server/memory/policy.ts')&&!url.endsWith('/server/memory/recall-view.ts'))return result;
        let source=String(result.source);
        if(url.endsWith('/server/memory/policy.ts')) {
          const anchor='export function memoryAccess(registry: InternalCapabilities, claim: InternalCapability, roster: () => MemoryRoster): MemoryAccess {';
          if(!source.includes(anchor))throw new Error('Cold-view fixture private-entry anchor missing');
          source='import {writeFileSync as coldFixtureWrite} from "node:fs";'+source.replace(anchor,anchor+'coldFixtureWrite('+JSON.stringify(marker)+',"");');
        } else if(url.endsWith('/server/memory/recall-view.ts')) {
          const anchor='export async function prepareRecallContext(botId: string,threadId: string,roster: MemoryRoster,notOwnerAudience=false): Promise<void> {';
          if(!source.includes(anchor))throw new Error('Cold-view fixture construction anchor missing');
          const hold=' const coldFixtureFs=await import("node:fs");const coldUntil=Date.now()+20000;while(!coldFixtureFs.existsSync('+JSON.stringify(marker)+')&&Date.now()<coldUntil)await new Promise(resolve=>setTimeout(resolve,10));await new Promise(resolve=>setTimeout(resolve,100));';
          const constructionTry='  try {while(!buildRecallViewSlice(build))';
          const at=source.indexOf(constructionTry,source.indexOf(anchor)+anchor.length);
          if(at<0)throw new Error('Cold-view fixture active construction anchor missing');
          source=source.slice(0,at)+source.slice(at).replace(constructionTry,'  try {'+hold+'while(!buildRecallViewSlice(build))');
        }
        return {...result,source};
      }});
    `,
  });
  const env = { MURAGE_URL: session.info.url };
  try {
    expect(await fixtureMemoryMode(session.info.url)).toBe('active');
    const { bot } = await runControlMurage(['new-bot', '--name', 'Cold-view fixture'], { env }) as any;
    await runControlMurage(['send', '--bot', bot.id, '--text', 'Reply once with the fixture result.'], { env });
    expect((await runControlMurage(['wait', '--bot', bot.id, '--timeout', '20'], { env }) as any).status).toBe('settled');
    const result = await runControlMurage(['messages', '--bot', bot.id, '--limit', '10'], { env }) as any;
    expect(result.messages.filter((message: any) => message.role === 'bot' && message.text === 'Fixture cold-view reply.')).toHaveLength(1);
    expect(readFileSync(session.info.logPath, 'utf8')).not.toContain('dispatch preparation failed');
  } finally { writeFileSync(join(session.info.dataDir, 'cold-view-requested'), ''); await session.close(); }
});

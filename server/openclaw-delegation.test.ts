// Delegation to an OpenClaw (own-tools) teammate, deterministic: a Chief on a
// normal engine calls delegate_bot, the teammate runs under the openclawAgent
// driver (ownTools code path) backed by the FAKE ACP CLI, and the teammate's
// reply folds back into the Chief's thread via the delegation receipt. The
// real-binary twin is openclaw-delegation.real.test.ts (local only).
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OpenclawAgentDriver } from "./drivers/acp/openclaw.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { bootFleet, FAKE_ACP_CLI, type Fleet } from "./testing/delegation-fleet.ts";

describe("delegate_bot to an OpenClaw own-tools teammate (fake ACP CLI)", () => {
  let fleet: Fleet;
  let dump = "";
  let dumpDir = "";

  beforeAll(async () => {
    chmodSync(FAKE_ACP_CLI, 0o755);
    dumpDir = mkdtempSync(join(tmpdir(), "oc-deleg-dump-"));
    dump = join(dumpDir, "teammate.json");
    fleet = await bootFleet(
      {
        chief: {
          driver: "grokAgent",
          environment: { FAKE_ACP_MODE: "delegate-peer", FAKE_ACP_DELEGATE_MESSAGE: "summarise the openclaw report", ...(process.env.DELEGATION_DIAG_PROFILE ? { FAKE_ACP_INIT_DELAY_MS: process.env.DELEGATION_DIAG_INIT_MS ?? "0" } : {}) },
          config: { cli: FAKE_ACP_CLI, fullAuto: true },
        },
        ocmate: {
          driver: "openclawAgent",
          environment: { FAKE_ACP_MODE: "happy", FAKE_ACP_DUMP: dump, ...(process.env.DELEGATION_DIAG_PROFILE ? { FAKE_ACP_INIT_DELAY_MS: process.env.DELEGATION_DIAG_INIT_MS ?? "0" } : {}) },
          config: { cli: FAKE_ACP_CLI, fullAuto: false, agent: "main" },
        },
      },
      "murage-oc-deleg-",
      // cddf1c168e requires confirmed read-only and independent boundary
      // coverage at every level. Supply the reviewed fixture seam for this
      // fake CLI; the production guard remains closed without a verifier.
      { instrumentationSource: `
        ${process.env.DELEGATION_TRACE ? `process.env.DELEGATION_TRACE = ${JSON.stringify(process.env.DELEGATION_TRACE)}; process.env.DELEGATION_DIAG_PROFILE = ${JSON.stringify(process.env.DELEGATION_DIAG_PROFILE ?? "")}; await import(${JSON.stringify(new URL(process.env.DELEGATION_DIAG_PROFILE ? "../evidence/fixm9-g3-diag/observer.mjs" : "../evidence/fixm9-g3/round3/provider-trace.mjs", import.meta.url).href)});` : ""}
        import { appendFileSync } from 'node:fs';
        import { isMainThread } from 'node:worker_threads';
        if (isMainThread) {
          const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL("./drivers/builtIn.ts", import.meta.url).href)});
          const { createAcpDriver } = await import(${JSON.stringify(new URL("./drivers/acp/core.ts", import.meta.url).href)});
          const { openclawSupport, createOpenclawPrePromptGuard } = await import(${JSON.stringify(new URL("./drivers/acp/openclaw.ts", import.meta.url).href)});
          const prePrompt = createOpenclawPrePromptGuard({
            probeVersion: async () => 'OpenClaw 2026.10.5',
            call: async (cli, method, params) => {
              if (cli !== ${JSON.stringify(FAKE_ACP_CLI)} || method !== 'sessions.patch') throw Error('unexpected fake Gateway call');
              appendFileSync(${JSON.stringify(`${dump}.gateway.jsonl`)}, JSON.stringify({ method, params }) + '\\n');
              return { ok: true, key: params.key, entry: { permissionMode: params.permissionMode } };
            },
            verifyCoverage: async (ctx) => ctx.config.cli === ${JSON.stringify(FAKE_ACP_CLI)} ? {
              refusedReads: true, skillRoots: true, extraTools: true, nativeHarnesses: true, delegation: true, readBoundary: true,
            } : undefined,
          });
          const index = BUILT_IN_DRIVERS.findIndex(driver => driver.driverKind === openclawSupport.driverKind);
          if (index < 0) throw Error('OpenClaw fixture driver missing');
          BUILT_IN_DRIVERS[index] = createAcpDriver({ ...openclawSupport, prePrompt });
        }
      ` },
    );
  }, 40_000);

  afterAll(async () => {
    await fleet?.stop();
    if (dumpDir) await removeTempDir(dumpDir);
  });

  it("declares the ownTools capability surface: no Murage mounts, no local-computer ask gate", async () => {
    const instance = await OpenclawAgentDriver.create({
      instanceId: "oc-caps",
      displayName: "OC caps",
      environment: {},
      enabled: true,
      config: { cli: FAKE_ACP_CLI, fullAuto: false },
    });
    try {
      const caps = instance.adapter.capabilities;
      expect(caps.runsOnOwnTools).toBe(true);
      for (const key of ["agentsMcp", "memoryMcp", "customMcp", "computerMcp", "composioMcp", "browserMcp", "localComputerMcp"] as const) {
        expect(caps[key], key).toBe(false);
      }
    } finally {
      await instance.dispose();
    }
  });

  it("Chief's delegate_bot reaches the OpenClaw teammate and its reply folds back into the Chief thread", async () => {
    const { api, waitFor } = fleet;
    const seeded = (await api("GET", "/api/bots")).body.bots[0];
    await api("PATCH", `/api/bots/${seeded.id}`, { hidden: true });
    const mate = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${mate.id}`, { name: "Claw", modelSelection: { instanceId: "ocmate", model: "openclaw-default" } });
    // Auto still requires read-only under cddf1c168e; the fake Gateway above
    // supplies that confirmation and the fixture's independent coverage.
    expect((await api("PATCH", `/api/bots/${mate.id}`, { autoApprove: true, acknowledgeLocalAuto: true })).status).toBe(200);
    const chief = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${chief.id}`, { name: "Chief", modelSelection: { instanceId: "chief", model: "fake-model" } });

    expect((await api("POST", `/api/bots/${chief.id}/messages`, { text: "hey @Claw please pick this up" })).status).toBe(202);

    const settled = await waitFor("delegation never folded back", 40_000, (state) => {
      const c = state.bots.find((b: any) => b.id === chief.id);
      const m = state.bots.find((b: any) => b.id === mate.id);
      const queued = c.messages.some((x: any) => x.kind === "activity" && x.tool?.name === "Delegated to @Claw: followup");
      const receipt = c.messages.find(
        (x: any) => x.role === "bot" && x.kind === "text" && x.from?.botId === mate.id
          && x.text?.includes("replied to the delegated task") && x.text?.includes("hello from fake acp"),
      );
      return queued && receipt && !m.busy && !c.busy ? { c, m, receipt } : undefined;
    });

    // (2) the queue acknowledgement is Chief's own and does not carry the reply
    const ack = settled.c.messages.find((x: any) => x.kind === "text" && x.role === "bot" && x.text?.includes("delegated:"));
    expect(ack.text).not.toContain("hello from fake acp");
    // (3) the receipt is attributed to the teammate and carries its terminal text
    expect(settled.receipt.from.botId).toBe(mate.id);

    // the teammate got the delegated task text, via the delegation prefix
    const inbound = settled.m.messages.find((x: any) => x.role === "user" && x.kind === "text");
    expect(inbound.text).toContain("[Delegated by @Chief");
    expect(inbound.text).toContain("summarise the openclaw report");

    // mirrored into the source A<->B channel, both directions
    const state = (await api("GET", "/api/bots")).body;
    const note = settled.c.messages.find((x: any) => x.kind === "activity" && x.tool?.name === "Messaged @Claw");
    const channel = state.groups.find((g: any) => g.id === note.comm.groupId);
    expect(channel.memberIds).toEqual(expect.arrayContaining([chief.id, mate.id]));
    expect(channel.messages.some((x: any) => x.from?.botId === chief.id && x.text?.includes("summarise the openclaw report"))).toBe(true);
    expect(channel.messages.some((x: any) => x.from?.botId === mate.id && x.text?.includes("hello from fake acp"))).toBe(true);

    // (1) the teammate ran under the ownTools path: spawned as `openclaw acp
    // --session agent:main:murage-...` (its own OpenClaw conversation), with
    // NO MCP mounts handed to session/new
    expect(existsSync(dump)).toBe(true);
    const spawned = JSON.parse(readFileSync(dump, "utf8"));
    expect(spawned.argv.join(" ")).toMatch(/acp --session agent:main:murage-(owner|guest)-[0-9a-f]{24}/);
    expect(JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8"))).toEqual([]);
    const gateway = readFileSync(`${dump}.gateway.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(gateway).toHaveLength(1);
    expect(gateway[0]).toEqual({ method: "sessions.patch", params: { key: spawned.argv[spawned.argv.indexOf("--session") + 1], permissionMode: "read-only" } });
  }, 70_000);
});

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

// Owners: recall-scope owns view admission; recall-smoke owns dispatch recovery
// and this real launcher/control/fake-engine consumer of that contract.
const source = (name: string) => JSON.stringify(pathToFileURL(resolve("server", name)).href);

const cases = ["fresh", "off", "paused", "twenty-bots", "burst", "held-publish", "index-missing", "index-upgrade"].map(state => ({ state, venue: "bot", cli: false }));
cases.push(...["index-missing", "index-upgrade"].map(state => ({ state, venue: "channel", cli: false })));
// MAIN RULING S3B-Q3: a CLI send carries no owner proof and never gets the owner's tools.
cases.push({ state: "fresh", venue: "bot", cli: true });
for (const { state, venue, cli } of cases) {
  it(`delivers the ${venue} engine reply with recall ${state} in a fresh isolated home${cli ? " from a CLI send without owner proof" : ""}`, async () => {
    const stateInstrumentation = ["fresh", "twenty-bots", "burst", "held-publish"].includes(state) ? "" : `
      await import(${source("memory/settle-target.ts")});
      const { database } = await import(${source("database.ts")});
      const { setMemoryMode } = await import(${source("memory/repository.ts")});
      setMemoryMode(${JSON.stringify(state === "off" || state === "paused" ? state : "active")});
      ${state.startsWith("index-") ? `
      const { registerHooks } = await import('node:module');
      registerHooks({ load(url, context, next) {
        const result = next(url, context);
        if (!url.endsWith('/server/index.ts')) return result;
        const needle = 'function turnMemoryAccess(botId: string, threadId: string, generation: string): MemoryAccess {';
        const effect = ${JSON.stringify(state === "index-missing"
          ? "database().prepare('DELETE FROM memory_recall_contexts').run();"
          : "database().prepare(\"UPDATE memory_recall_views SET state='building' WHERE state='ready'\").run();")};
        const text = String(result.source);
        if (!text.includes(needle)) throw new Error('fixture recall injection missing');
        return { ...result, source: text.replace(needle, needle + effect + ${JSON.stringify(`console.warn('fixture recall state=${state}');`)}) };
      }});
      ` : ""}
    `;
    // MAIN RULING recall-audit-b ROUND 2 (GATE): observe the actual adapter request,
    // as well as the reply. Counts keep fixture diagnostics free of user text.
    const heldInstrumentation = state !== "held-publish" ? "" : `
      const { registerHooks: fixtureHeldHooks } = await import('node:module');
      fixtureHeldHooks({load(url,context,next){
        const result=next(url,context);let text=String(result.source);
        if(url.endsWith('/server/memory/recall-view.ts')) {
          const needle='export function resolveRecallView(binding: RecallViewBinding, roster: MemoryRoster): Held {';
          text=text.replace(needle,needle+"if(!globalThis.fixtureHeldPublished)throw new RecallPreparationPending();");
        }
        if(url.endsWith('/server/index.ts')) {
          const start='const directStoredMemoryMode = memoryState().mode;';
          text=text.replace(start,start+"if(!globalThis.fixtureHeldSeeded){globalThis.fixtureHeldSeeded=true;globalThis.fixtureSeed(bot.id);}");
          const mode='const directMemoryMode = opts?.recallHeld ? "paused" : directStoredMemoryMode;';
          text=text.replace(mode,mode+"if(opts?.recallHeld){globalThis.fixtureHeldPublished=true;globalThis.fixturePrepare(bot.id,threadId,store,memoryNotOwner);console.warn('fixture held published');}");
        }
        return {...result,source:text};
      }});
      await import(${source("memory/settle-target.ts")});
      const { prepareRecallContextSync: fixturePrepare } = await import(${source("memory/recall-view.ts")});
      const { ensureScope: fixtureScope } = await import(${source("memory/policy.ts")});
      const { database: fixtureDb } = await import(${source("database.ts")});
      globalThis.fixturePrepare = fixturePrepare;
      globalThis.fixtureSeed = botId => {
        const scope=fixtureScope('bot',botId);
        fixtureDb().prepare("INSERT OR IGNORE INTO memory_records VALUES('fixture-held-record',1,?,'constraint','Fixture remembered words','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
      };
    `;
    const instrumentationSource = stateInstrumentation + heldInstrumentation + `
      const { registerHooks: registerRequestHooks } = await import('node:module');
      await import(${source("memory/settle-target.ts")});
      const { database: fixtureDatabase } = await import(${source("database.ts")});
      const { captureSource: fixtureCapture } = await import(${source("memory/capture.ts")});
      globalThis.fixtureDatabase = fixtureDatabase;
      globalThis.fixtureCapture = fixtureCapture;
      globalThis.fixtureDispatched = 0;
      registerRequestHooks({ load(url, context, next) {
        const result = next(url, context);
        if (!url.endsWith('/server/index.ts')) return result;
        let text = String(result.source);
        const request = 'async function sendProjectUsageTurn(instance: ProviderInstance, built: BuiltSendTurnInput, fence: EngineFence) {';
        if (!text.includes(request)) throw new Error('fixture request observation missing');
        text = text.replace(request, request + \`
          globalThis.fixtureDispatched++;
          console.warn('fixture dispatch fields=' + JSON.stringify({system: built.system?.trim().length ?? 0, transcript: built.transcript?.length ?? 0, integrations: Object.keys(built.integrations ?? {}).length, recall: built.recall, persona: built.system?.includes("Integration fixture"), tool: Boolean(built.integrations?.agents), history: JSON.stringify(built.transcript ?? []).includes("Fixture integration turn.") || built.prompt.text.includes("Fixture integration turn."), memory: Boolean(built.integrations?.memory)}));
        \`);
        if (${JSON.stringify(state === "burst")}) {
          const admission = 'function turnMemoryAccess(botId: string, threadId: string, generation: string): MemoryAccess {';
          if (!text.includes(admission)) throw new Error('fixture burst observation missing');
          text = text.replace(admission, admission + \`
            if (globalThis.fixtureDispatched === 1 && !globalThis.fixtureBurstDone) {
              globalThis.fixtureBurstDone = true;
              for (let n = 0; n < 600; n++) globalThis.fixtureCapture(globalThis.fixtureDatabase(), {id: 'fixture-burst-' + n, threadId, kind: 'text', speaker: 'owner', outcome: 'recorded', text: 'Fixture burst message ' + n});
              console.warn('fixture captured burst=600');
            }
          \`);
        }
        return {...result, source: text};
      }});
    `;
    const reply = "Fixture integration reply.";
    const fixture = await launchVerificationServer(process.env, undefined, {
      separateHome: true, turnLog: { replies: [reply, reply] }, instrumentationSource,
    });
    const env = { MURAGE_DATA_DIR: fixture.info.dataDir };
    const run = (args: string[]) => runControlMurage([...args, "--url", fixture.info.url], { env }) as Promise<any>;
    try {
      expect((await run(["doctor"])).ok).toBe(true);
      const created = await run(["new-bot", "--name", "Integration fixture"]);
      if (state === "twenty-bots") {
        for (let n = 1; n < 20; n++) await run(["new-bot", "--name", `Fixture reader ${n}`]);
      }
      const id = venue === "bot" ? created.bot.id
        : (await run(["new-channel", "--name", "Integration room", "--members", created.bot.id])).channel.id;
      const destination = [`--${venue}`, id];
      if (state === "off" || state === "paused") {
        // Set the owner preference after boot's fresh-install migration.
        const { secret } = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
        const response = await fetch(fixture.info.url + "/api/memory/action", {
          method: "POST", headers: { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret },
          body: JSON.stringify({ action: "configure", mode: state }),
        });
        expect(response.status).toBe(200);
        const status = await (await fetch(fixture.info.url + "/api/memory/status", {
          headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret },
        })).json() as { mode: string };
        expect(status.mode).toBe(state);
      }
      const sendFixture = async (text: string) => {
        if (cli) return run([venue === "bot" ? "send" : "send-channel", ...destination, "--text", text]);
        const {secret} = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as {secret:string};
        const response = await fetch(fixture.info.url + `/api/${venue === "bot" ? "bots" : "groups"}/${id}/messages`, {method:"POST",headers:{"content-type":"application/json","x-murage-surface":"desktop","x-murage-surface-secret":secret},body:JSON.stringify({text})});
        expect(response.status).toBe(202);
      };
      await sendFixture("Fixture integration turn.");
      expect((await run(["wait", ...destination, "--timeout", "30"])).status, readFileSync(fixture.info.logPath, "utf8").slice(-12000)).toBe("settled");
      const transcript = await run(["messages", ...destination, "--limit", "10"]);
      expect(transcript.messages.some((message: { text?: string }) => message.text === reply),
        JSON.stringify(transcript) + "\n" + readFileSync(fixture.info.logPath, "utf8").slice(-6000)).toBe(true);
      expect(readFileSync(fixture.fixtureTurnLogPath, "utf8").trim().split("\n")).toHaveLength(1);
      {
        // Establish real earlier conversation before checking history delivery.
        // A first message alone legitimately has no earlier transcript rows.
        await sendFixture("Fixture follow-up that needs the earlier conversation.");
        expect((await run(["wait", ...destination, "--timeout", "30"])).status, readFileSync(fixture.info.logPath, "utf8").slice(-12000)).toBe("settled");
        if (state === "burst") expect(readFileSync(fixture.info.logPath, "utf8")).toContain("fixture captured burst=600");
      }
      // Settled or an activity/error row alone never proves that an engine ran.
      const turns = readFileSync(fixture.fixtureTurnLogPath, "utf8").trim().split("\n");
      // MAIN RULING recall-audit-b ROUND 2 (GATE): the follow-up establishes real
      // history; retain the original one-turn assertion above and count both here.
      expect(turns,readFileSync(fixture.info.logPath,"utf8").slice(-16000)).toHaveLength(2);
      {
        const log = readFileSync(fixture.info.logPath, "utf8");
        const requests = [...log.matchAll(/fixture dispatch fields=(\{[^\n]+\})/g)].map(match => JSON.parse(match[1]));
        expect(requests).toHaveLength(2);
        expect([...log.matchAll(/turn dispatch recall=(full|pins|held|off) thread=/g)]).toHaveLength(2);
        for (const request of requests) {
          expect(request.system).toBeGreaterThan(0);
          expect(request.persona).toBe(true);
          // MAIN RULING S3B-Q3: only the owner-proof (desktop secret) send mounts the agents tool.
          if (cli) expect(request.tool).toBe(false);
          else {
            expect(request.integrations).toBeGreaterThan(0);
            expect(request.tool).toBe(true);
          }
        }
        // MAIN RULING 1114-SMOKE-MUST-SEE-C1: room history is carried in prompt parts; assert its words as well as direct transcript rows.
        if (venue === "bot") expect(requests.at(-1).transcript).toBeGreaterThan(0);
        expect(requests.at(-1).history).toBe(true);
        if (state === "off" || state === "paused") expect(requests.every(request => request.recall === "off")).toBe(true);
        if (state.startsWith("index-")) expect(requests.every(request => request.recall === "held")).toBe(true);
        if(state==="held-publish") {
          expect(requests[0].recall).toBe("held");
          expect(requests[0].memory).toBe(false);
          expect(requests[1].recall).toBe("full");
          expect((log.match(/fixture held published/g)??[])).toHaveLength(1);
          const finalTranscript=await run(["messages",...destination,"--limit","30"]);
          // FLIPPED by 1.0.24 q1024-forgetracerace (FRICTION F20 + F21): this asserted the one "Memory wasn't ready" row; the held dispatch is the log line.
          expect(finalTranscript.messages.filter((message:any)=>/Memory wasn't ready/.test(message.tool?.name??""))).toHaveLength(0);
          expect(log).toContain("turn dispatch recall=held");
        }
        expect(log).not.toContain("starting turn without recalled memory");
      }
      if (state.startsWith("index-")) {
        const log = readFileSync(fixture.info.logPath, "utf8");
        expect(log).toContain(`fixture recall state=${state}`);
        expect(log).not.toContain("starting turn without recalled memory");
      }
    } catch(error) {
      console.error('fixture failed state='+state+' exit='+fixture.child.exitCode+' signal='+fixture.child.signalCode);
      console.error(readFileSync(fixture.info.logPath,'utf8'));
      throw error;
    } finally {
      await fixture.close();
    }
  }, 120_000);
}

// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OPENCODE-QUIET-1023 W3 room (Fable r2 M4): an OpenCode room member's owned provider failure, quiet for 60 s,
// folds into the room thread as exactly one activity message with the plain line, and that row survives an
// isolated restart. Real server, real OpenCode driver and fold; the engine is the fake ACP CLI in its captured
// 1.19.5-grammar `opencode-quiet` mode.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

const LINE = /^OpenCode reported a rate limit\. No reply for \d+ seconds\.$/;
let fixture: VerificationServer, headers: Record<string, string>;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.ok).toBe(true);
  return await response.json() as any;
};
const login = async () => {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
};

describe.skipIf(process.platform === "win32")("OpenCode quiet line in a room thread", () => {
  beforeAll(async () => {
    const href = (path: string) => JSON.stringify(pathToFileURL(join(process.cwd(), path)).href);
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      process.env.MURAGE_ACP_PROMPT_IDLE_MS='65000'; process.env.NODE_ENV='test'; globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${href("server/drivers/builtIn.ts")});
      const {OpenCodeDriver,openCodeAcpSupport}=await import(${href("server/drivers/acp/opencode-go.ts")});
      const {createAcpDriver}=await import(${href("server/drivers/acp/core.ts")});
      const at=BUILT_IN_DRIVERS.indexOf(OpenCodeDriver); if(at<0) throw new Error('OpenCode driver not registered');
      // The real OpenCode support table with a fixture catalog. The fake CLI cannot answer the destination probe (not under test),
      // so the probe returns the fixture provider's loopback URL, as a real OpenCode with that config would.
      BUILT_IN_DRIVERS[at]=createAcpDriver({...openCodeAcpSupport(async()=>({default:'fixture/mock',options:[{id:'fixture/mock',label:'Mock'}]})),
        effectiveDestination:async()=>({provider:'fixture',urls:['http://127.0.0.1:9/v1']}),disposeDestination:()=>{}});
      const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.quiet={driver:'opencodeGo',config:{cli:${JSON.stringify(join(process.cwd(), "server/testing/fake-acp-cli.ts"))},fullAuto:false},
        environment:{FAKE_ACP_MODE:'opencode-quiet',FAKE_ACP_MCP_CONNECT:'1',FAKE_ACP_MODELS:'fixture/mock',OPENCODE_API_KEY:'local-fixture-only'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    await login();
  }, 60000);
  afterAll(async () => { await fixture?.close(); });

  it("shows exactly one activity line in the room and keeps it across a restart", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Quiet member", modelSelection: { instanceId: "quiet", model: "fixture/mock" } })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const group = (await api("POST", "/api/groups", { name: "Quiet room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).group;
    const threadId = group.threadId;
    await api("POST", `/api/groups/${group.id}/messages`, { threadId, text: "offline" });
    const messages = async () => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[]);
    const quietRows = (all: any[]) => all.filter(message => message.kind === "activity" && LINE.test(message.tool?.name ?? ""));
    const sent = Date.now();
    // The line is due 60 s after the prompt; the unchanged silence deadline (65 s here) then ends the turn.
    await new Promise(resolve => setTimeout(resolve, 72000));
    const shown = await messages();
    expect(quietRows(shown)).toHaveLength(1);
    expect(quietRows(shown)[0].at - sent).toBeGreaterThanOrEqual(59000);
    expect(JSON.stringify(shown)).not.toContain("Local fixture rate limit");
    await fixture.restart();
    await login();
    expect(quietRows(await messages())).toHaveLength(1);
  }, 150000);
});
